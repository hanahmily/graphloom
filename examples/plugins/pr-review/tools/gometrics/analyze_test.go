// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func analyze(t *testing.T, src string) *FileInfo {
	t.Helper()
	info, err := Analyze("x.go", []byte(src))
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func byName(info *FileInfo) map[string]*Func {
	out := map[string]*Func{}
	for _, f := range info.Funcs {
		out[strings.TrimPrefix(f.Name, info.Package+".")] = f
	}
	return out
}

// total is gocyclo's number for fn: its own complexity plus that of every
// closure nested in it (gocyclo does not separate function literals).
func total(fn *Func) int {
	n := 1 + len(fn.Decisions)
	for _, c := range fn.Children {
		n += total(c) - 1
	}
	return n
}

func TestMatchesGocycloOnCorpus(t *testing.T) {
	raw, err := os.ReadFile("testdata/gocyclo-expected.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected struct {
		Files map[string]map[string]int `json:"files"`
	}
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}
	for file, want := range expected.Files {
		src, err := os.ReadFile(filepath.Join("testdata", "corpus", file))
		if err != nil {
			t.Fatal(err)
		}
		info, err := Analyze(file, src)
		if err != nil {
			t.Fatal(err)
		}
		funcs := byName(info)
		for name, n := range want {
			fn, ok := funcs[name]
			if !ok {
				t.Errorf("%s: no function %q in %v", file, name, keys(funcs))
				continue
			}
			if got := total(fn); got != n {
				t.Errorf("%s %s: gocyclo %d, gometrics %d", file, name, n, got)
			}
		}
	}
}

func keys(m map[string]*Func) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestOwnCountsExcludeClosures(t *testing.T) {
	src, _ := os.ReadFile("testdata/corpus/closures.go")
	info, err := Analyze("closures.go", src)
	if err != nil {
		t.Fatal(err)
	}
	f := byName(info)
	cases := map[string]int{
		"Sorted":             1,
		"Sorted.func1":       2,
		"Nested":             1,
		"Nested.func1":       2,
		"Nested.func1.func1": 3,
		"TwoLiterals":        2,
		"TwoLiterals.func1":  2,
		"TwoLiterals.func2":  1,
		"WithDefer.func1":    2,
		"glob.func1":         2,
		"WithDefer":          2,
	}
	for name, want := range cases {
		fn := f[name]
		if fn == nil {
			t.Errorf("missing %s in %v", name, keys(f))
			continue
		}
		if got := 1 + len(fn.Decisions); got != want {
			t.Errorf("%s: complexity %d, want %d", name, got, want)
		}
	}
}

func TestNesting(t *testing.T) {
	src, _ := os.ReadFile("testdata/corpus/basic.go")
	info, err := Analyze("basic.go", src)
	if err != nil {
		t.Fatal(err)
	}
	f := byName(info)
	cases := map[string]int{
		"Empty":      0,
		"Straight":   0,
		"Branches":   1, // else if stays at the if's level
		"Switchy":    1, // case clauses add nothing
		"TypeSwitch": 1,
		"Selecty":    1,
		"Loops":      1,
		"Deep":       4, // for, for, if, switch
		"initOnce":   2,
	}
	for name, want := range cases {
		if got := len(f[name].Nesting); got != want {
			t.Errorf("%s: nesting %d, want %d", name, got, want)
		}
	}
	deep := f["Deep"].Nesting
	kinds := []string{}
	for _, s := range deep {
		kinds = append(kinds, s.Kind)
	}
	if strings.Join(kinds, ",") != "for,for,if,switch" {
		t.Errorf("Deep path kinds %v", kinds)
	}
	for i := 1; i < len(deep); i++ {
		if deep[i].Line <= deep[i-1].Line {
			t.Errorf("path lines not increasing: %v", deep)
		}
	}
}

func TestNestingElseBlockVsElseIf(t *testing.T) {
	info := analyze(t, `package p

func f(a, b bool) {
	if a {
	} else {
		if b {
		}
	}
}

func g(a, b bool) {
	if a {
	} else if b {
	}
}
`)
	f := byName(info)
	if n := len(f["f"].Nesting); n != 2 {
		t.Errorf("else { if } nesting %d, want 2", n)
	}
	if n := len(f["g"].Nesting); n != 1 {
		t.Errorf("else if nesting %d, want 1", n)
	}
}

func TestClosuresDoNotNestIntoEnclosing(t *testing.T) {
	info := analyze(t, `package p

func f(xs []int) {
	go func() {
		for range xs {
			if len(xs) > 0 {
			}
		}
	}()
}
`)
	f := byName(info)
	if n := len(f["f"].Nesting); n != 0 {
		t.Errorf("enclosing nesting %d, want 0", n)
	}
	if n := len(f["f.func1"].Nesting); n != 2 {
		t.Errorf("closure nesting %d, want 2", n)
	}
}

func TestNames(t *testing.T) {
	info := analyze(t, `package schema

type T struct{}
type G[K any] struct{}

func ParseTTL() {}
func (t *T) Ptr() {}
func (t T) Val() {}
func (g *G[K]) Gen() {}
func Param[K any]() {}
func init() {}
`)
	var names []string
	for _, f := range info.Funcs {
		names = append(names, f.Name)
	}
	want := "schema.ParseTTL,schema.(*T).Ptr,schema.T.Val,schema.(*G[...]).Gen,schema.Param[...],schema.init"
	if strings.Join(names, ",") != want {
		t.Errorf("names\n got %v\nwant %s", names, want)
	}
}

const scopeSrc = `package p

func Untouched() int {
	return 1
}

func Modified(a int) int {
	b := a
	return b + 1
}

func Added() int {
	return 2
}

func Outer() {
	x := 0
	run(func() {
		x++
	})
	_ = x
}
`

func classify(t *testing.T, changed ...Range) map[string]string {
	t.Helper()
	info := analyze(t, scopeSrc)
	set := changedSet(changed)
	out := map[string]string{}
	for _, f := range info.Funcs {
		if c := Classify(f, set); c != "" {
			out[strings.TrimPrefix(f.Name, "p.")] = c
		}
	}
	return out
}

func TestChangedFunctionScope(t *testing.T) {
	// line 8 is inside Modified's body; lines 12-14 are the whole of Added.
	got := classify(t, Range{8, 8}, Range{12, 14})
	if len(got) != 2 || got["Modified"] != "modified" || got["Added"] != "added" {
		t.Errorf("got %v", got)
	}
	// A signature-only change modifies the function.
	if got := classify(t, Range{7, 7}); got["Modified"] != "modified" {
		t.Errorf("signature change: %v", got)
	}
	// Nothing in a function: untouched, even when its neighbours change.
	if got := classify(t, Range{6, 6}, Range{11, 11}); len(got) != 0 {
		t.Errorf("blank-line change measured: %v", got)
	}
	// A change strictly inside a closure touches the closure, not Outer.
	if got := classify(t, Range{19, 19}); len(got) != 1 || got["Outer.func1"] != "modified" {
		t.Errorf("closure interior: %v", got)
	}
	// A change on the line that opens the closure touches both.
	got = classify(t, Range{18, 18})
	if got["Outer"] != "modified" || got["Outer.func1"] != "modified" {
		t.Errorf("closure boundary: %v", got)
	}
	// A change in Outer's own code outside the closure leaves the closure alone.
	if got := classify(t, Range{21, 21}); got["Outer"] != "modified" || len(got) != 1 {
		t.Errorf("own line after the closure: %v", got)
	}
}

func TestGeneratedHeader(t *testing.T) {
	info := analyze(t, "// Code generated by protoc-gen-go. DO NOT EDIT.\n\npackage p\n\nfunc F() {}\n")
	if !info.Generated {
		t.Error("generated header not detected")
	}
	info = analyze(t, "package p\n\n// Code generated by hand. DO NOT EDIT.\nfunc F() {}\n")
	if info.Generated {
		t.Error("marker after the package clause must not count")
	}
	info = analyze(t, "// Code generated by x; maybe not.\n\npackage p\n")
	if info.Generated {
		t.Error("marker without DO NOT EDIT must not count")
	}
}

func TestRunSkipsGeneratedAndMarksTests(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a/gen.go", "// Code generated by x. DO NOT EDIT.\n\npackage a\n\nfunc G(x int) int {\n\tif x > 0 {\n\t\treturn 1\n\t}\n\treturn 0\n}\n")
	write("a/pb/api.pb.go", "package pb\n\nfunc P() {}\n")
	write("a/a.go", "package a\n\nfunc A(x int) int {\n\tif x > 0 {\n\t\treturn 1\n\t}\n\treturn 0\n}\n")
	write("a/a_test.go", "package a\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tif A(1) != 1 {\n\t\tt.Fatal()\n\t}\n}\n")
	hunks := map[string][]Range{
		"a/gen.go": {{1, 10}}, "a/pb/api.pb.go": {{1, 3}}, "a/a.go": {{3, 8}},
		"a/a_test.go": {{5, 9}}, "README.md": {{1, 1}}, "a/gone.go": {{1, 2}},
	}
	doc, err := run(dir, hunks, []string{"**/*.pb.go"})
	if err != nil {
		t.Fatal(err)
	}
	reasons := map[string]string{}
	for _, s := range doc.Skipped {
		reasons[s.Path] = s.Reason
	}
	want := map[string]string{
		"a/gen.go": "generated", "a/pb/api.pb.go": "generated",
		"README.md": "unsupported-language", "a/gone.go": "not-in-head",
	}
	for p, r := range want {
		if reasons[p] != r {
			t.Errorf("skip %s: %q, want %q", p, reasons[p], r)
		}
	}
	if len(doc.Records) != 2 {
		t.Fatalf("records %+v", doc.Records)
	}
	for _, r := range doc.Records {
		if r.Path == "a/a_test.go" && !r.Test {
			t.Error("test record not marked")
		}
		if r.Path == "a/a.go" && (r.Test || r.Complexity != 2 || r.Change != "added") {
			t.Errorf("bad record %+v", r)
		}
	}
}

func TestParseHunks(t *testing.T) {
	h, err := parseHunks(strings.NewReader("# c\npkg/a.go:3-5\npkg/a.go:9\n\nb:c.go:1-1\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(h["pkg/a.go"]) != 2 || h["pkg/a.go"][1] != (Range{9, 9}) || len(h["b:c.go"]) != 1 {
		t.Errorf("hunks %v", h)
	}
	if _, err := parseHunks(strings.NewReader("nope\n")); err == nil {
		t.Error("expected error")
	}
	if _, err := parseHunks(strings.NewReader("a.go:5-3\n")); err == nil {
		t.Error("expected error for reversed range")
	}
}

func TestGlob(t *testing.T) {
	cases := []struct {
		glob, path string
		want       bool
	}{
		{"**/*.pb.go", "a/b/x.pb.go", true},
		{"**/*.pb.go", "x.pb.go", true},
		{"*.pb.go", "a/x.pb.go", false},
		{"gen/**", "gen/a/b.go", true},
		{"gen/*.go", "gen/a/b.go", false},
		{"a?.go", "ab.go", true},
	}
	for _, c := range cases {
		if got := globRe(c.glob).MatchString(c.path); got != c.want {
			t.Errorf("%s ~ %s = %v", c.glob, c.path, got)
		}
	}
	if !matchesGenerated([]*regexp.Regexp{globRe("*.pb.go")}, []string{"*.pb.go"}, "a/x.pb.go") {
		t.Error("slashless glob should match the base name")
	}
}
