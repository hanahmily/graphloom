// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const schema = "graphloom-metrics-v1"

// Record is one measured function (design-code-quality-metrics.md §5).
type Record struct {
	Path        string `json:"path"`
	Function    string `json:"function"`
	StartLine   int    `json:"startLine"`
	EndLine     int    `json:"endLine"`
	Change      string `json:"change"`
	Test        bool   `json:"test"`
	Complexity  int    `json:"complexity"`
	Decisions   []Step `json:"decisions"`
	Nesting     int    `json:"nesting"`
	NestingPath []Step `json:"nestingPath"`
}

// FileIndex lists every function of a changed file as [name, start, end].
type FileIndex struct {
	Path      string          `json:"path"`
	Language  string          `json:"language"`
	Test      bool            `json:"test"`
	Functions [][]interface{} `json:"functions"`
}

// Skipped is a changed path that was not measured, with the reason.
type Skipped struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// Document is the tool's whole output.
type Document struct {
	Schema  string      `json:"schema"`
	Tool    string      `json:"tool"`
	Records []Record    `json:"records"`
	Files   []FileIndex `json:"files"`
	Skipped []Skipped   `json:"skipped"`
}

var hunkRe = regexp.MustCompile(`^(.+):(\d+)(?:-(\d+))?$`)

// parseHunks reads `path:start-end` (or `path:line`) lines; blank lines and
// lines starting with # are ignored.
func parseHunks(r io.Reader) (map[string][]Range, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	out := map[string][]Range{}
	for i, raw := range strings.Split(string(data), "\n") {
		text := strings.TrimSpace(raw)
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		m := hunkRe.FindStringSubmatch(text)
		if m == nil {
			return nil, fmt.Errorf("hunks line %d: want path:start-end, got %q", i+1, text)
		}
		start, _ := strconv.Atoi(m[2])
		end := start
		if m[3] != "" {
			end, _ = strconv.Atoi(m[3])
		}
		if start < 1 || end < start {
			return nil, fmt.Errorf("hunks line %d: bad range %q", i+1, text)
		}
		out[m[1]] = append(out[m[1]], Range{start, end})
	}
	return out, nil
}

// globRe converts a path glob to a regexp: ** crosses directories, * and ?
// do not.
func globRe(glob string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(glob); i++ {
		switch c := glob[i]; c {
		case '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				i++
				if i+1 < len(glob) && glob[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// matchesGenerated applies the profile globs. A glob without a slash also
// matches the file's base name.
func matchesGenerated(globs []*regexp.Regexp, raw []string, p string) bool {
	for i, re := range globs {
		if re.MatchString(p) {
			return true
		}
		if !strings.Contains(raw[i], "/") && re.MatchString(path.Base(p)) {
			return true
		}
	}
	return false
}

func run(headDir string, hunks map[string][]Range, generated []string) (*Document, error) {
	doc := &Document{Schema: schema, Tool: "gometrics", Records: []Record{}, Files: []FileIndex{}, Skipped: []Skipped{}}
	var globs []*regexp.Regexp
	for _, g := range generated {
		globs = append(globs, globRe(g))
	}
	for _, p := range sortedPaths(hunks) {
		if !strings.HasSuffix(p, ".go") {
			doc.Skipped = append(doc.Skipped, Skipped{p, "unsupported-language"})
			continue
		}
		if matchesGenerated(globs, generated, p) {
			doc.Skipped = append(doc.Skipped, Skipped{p, "generated"})
			continue
		}
		src, err := os.ReadFile(filepath.Join(headDir, filepath.FromSlash(p)))
		if err != nil {
			if os.IsNotExist(err) {
				doc.Skipped = append(doc.Skipped, Skipped{p, "not-in-head"})
				continue
			}
			return nil, err
		}
		info, err := Analyze(p, src)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		if info.Generated {
			doc.Skipped = append(doc.Skipped, Skipped{p, "generated"})
			continue
		}
		isTest := strings.HasSuffix(p, "_test.go")
		idx := FileIndex{Path: p, Language: "go", Test: isTest, Functions: [][]interface{}{}}
		changed := changedSet(hunks[p])
		for _, fn := range info.Funcs {
			idx.Functions = append(idx.Functions, []interface{}{fn.Name, fn.Start, fn.End})
			change := Classify(fn, changed)
			if change == "" {
				continue
			}
			decisions := fn.Decisions
			if decisions == nil {
				decisions = []Step{}
			}
			doc.Records = append(doc.Records, Record{
				Path: p, Function: fn.Name, StartLine: fn.Start, EndLine: fn.End,
				Change: change, Test: isTest, Complexity: 1 + len(decisions),
				Decisions: decisions, Nesting: len(fn.Nesting), NestingPath: fn.Nesting,
			})
		}
		doc.Files = append(doc.Files, idx)
	}
	return doc, nil
}

func main() {
	head := flag.String("head", "", "head checkout directory")
	hunksPath := flag.String("hunks", "", "file of path:start-end head-side changed ranges (- for stdin)")
	generated := flag.String("generated", "", "comma-separated globs of generated files")
	flag.Parse()
	if *head == "" || *hunksPath == "" {
		fmt.Fprintln(os.Stderr, "usage: gometrics --head <dir> --hunks <file|-> [--generated <globs>]")
		os.Exit(2)
	}
	var in io.Reader = os.Stdin
	if *hunksPath != "-" {
		f, err := os.Open(*hunksPath)
		if err != nil {
			fmt.Fprintln(os.Stderr, "gometrics:", err)
			os.Exit(2)
		}
		defer f.Close()
		in = f
	}
	hunks, err := parseHunks(in)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gometrics:", err)
		os.Exit(2)
	}
	var globs []string
	for _, g := range strings.Split(*generated, ",") {
		if g = strings.TrimSpace(g); g != "" {
			globs = append(globs, g)
		}
	}
	doc, err := run(*head, hunks, globs)
	if err != nil {
		fmt.Fprintln(os.Stderr, "gometrics:", err)
		os.Exit(1)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		fmt.Fprintln(os.Stderr, "gometrics:", err)
		os.Exit(1)
	}
}
