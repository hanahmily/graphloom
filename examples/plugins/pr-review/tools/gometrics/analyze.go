// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Package main implements gometrics, the Go half of the GraphLoom code
// quality metrics (docs/design-code-quality-metrics.md §2.1, §2.2 and §5).
// It parses Go source with the standard library only and reports, for every
// function the change adds or modifies, its cyclomatic complexity, nesting
// depth and the line evidence that recomputation needs.
package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"sort"
	"strconv"
)

// Step is one line of evidence: a decision point or a control block.
type Step struct {
	Line int    `json:"line"`
	Kind string `json:"kind"`
}

// Func is one function, method or function literal of a file.
type Func struct {
	Name      string
	Start     int
	End       int
	Decisions []Step
	Nesting   []Step
	Children  []*Func
	closures  int
}

// FileInfo is the analysis of one Go file.
type FileInfo struct {
	Package   string
	Generated bool
	Funcs     []*Func
}

var generatedRe = regexp.MustCompile(`^// Code generated .* DO NOT EDIT\.$`)

// Analyze parses src and measures every function in it. Closures are their
// own functions, named <enclosing>.func<n> in source order, and are excluded
// from the enclosing function's decisions and nesting.
func Analyze(path string, src []byte) (*FileInfo, error) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, src, parser.ParseComments|parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	info := &FileInfo{Package: file.Name.Name}
	for _, group := range file.Comments {
		if group.Pos() >= file.Package {
			break
		}
		for _, c := range group.List {
			if generatedRe.MatchString(c.Text) {
				info.Generated = true
			}
		}
	}
	line := func(p token.Pos) int { return fset.PositionFor(p, false).Line }
	// Package-level closures hang off an unrecorded pseudo function.
	glob := &Func{Name: info.Package + ".glob"}
	for _, decl := range file.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok {
			measure(info, fset, glob, decl)
			continue
		}
		fn := &Func{
			Name:  info.Package + "." + declName(fd),
			Start: line(fd.Type.Func),
			End:   line(fd.End()),
		}
		info.Funcs = append(info.Funcs, fn)
		if fd.Body != nil {
			measure(info, fset, fn, fd.Body)
		}
	}
	return info, nil
}

// declName is the runtime-style name of a declaration without the package:
// Name, (*Recv).Name or Recv.Name; type parameters print as [...].
func declName(fd *ast.FuncDecl) string {
	name := fd.Name.Name
	if fd.Type.TypeParams != nil {
		name += "[...]"
	}
	if fd.Recv == nil || len(fd.Recv.List) == 0 {
		return name
	}
	return receiverName(fd.Recv.List[0].Type) + "." + name
}

func receiverName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return "(*" + receiverName(t.X) + ")"
	case *ast.ParenExpr:
		return receiverName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr:
		return receiverName(t.X) + "[...]"
	case *ast.IndexListExpr:
		return receiverName(t.X) + "[...]"
	}
	return "?"
}

// measure walks root as the own body of fn. A function literal inside it
// becomes a child function and is measured on its own.
func measure(info *FileInfo, fset *token.FileSet, fn *Func, root ast.Node) {
	line := func(p token.Pos) int { return fset.PositionFor(p, false).Line }
	var stack []ast.Node
	var added []bool
	var path []Step
	best := []Step{}
	ast.Inspect(root, func(n ast.Node) bool {
		if n == nil {
			top := len(stack) - 1
			if added[top] {
				path = path[:len(path)-1]
			}
			stack, added = stack[:top], added[:top]
			return true
		}
		if lit, ok := n.(*ast.FuncLit); ok {
			fn.closures++
			child := &Func{
				Name:  fn.Name + ".func" + strconv.Itoa(fn.closures),
				Start: line(lit.Type.Func),
				End:   line(lit.End()),
			}
			fn.Children = append(fn.Children, child)
			info.Funcs = append(info.Funcs, child)
			measure(info, fset, child, lit.Body)
			return false
		}
		switch t := n.(type) {
		case *ast.IfStmt:
			fn.Decisions = append(fn.Decisions, Step{line(t.If), "if"})
		case *ast.ForStmt:
			fn.Decisions = append(fn.Decisions, Step{line(t.For), "for"})
		case *ast.RangeStmt:
			fn.Decisions = append(fn.Decisions, Step{line(t.For), "for"})
		case *ast.CaseClause:
			if t.List != nil {
				fn.Decisions = append(fn.Decisions, Step{line(t.Case), "case"})
			}
		case *ast.CommClause:
			if t.Comm != nil {
				fn.Decisions = append(fn.Decisions, Step{line(t.Case), "case"})
			}
		case *ast.BinaryExpr:
			if t.Op == token.LAND {
				fn.Decisions = append(fn.Decisions, Step{line(t.OpPos), "&&"})
			} else if t.Op == token.LOR {
				fn.Decisions = append(fn.Decisions, Step{line(t.OpPos), "||"})
			}
		}
		step, level := levelOf(n, stack, line)
		stack = append(stack, n)
		added = append(added, level)
		if level {
			path = append(path, step)
			if len(path) > len(best) {
				best = append([]Step(nil), path...)
			}
		}
		return true
	})
	fn.Nesting = best
}

// levelOf reports whether n adds a nesting level. An else-if stays at its
// if's level, so an IfStmt that is its parent's Else adds none; a case
// clause adds none beyond its switch.
func levelOf(n ast.Node, stack []ast.Node, line func(token.Pos) int) (Step, bool) {
	switch t := n.(type) {
	case *ast.IfStmt:
		if len(stack) > 0 {
			if p, ok := stack[len(stack)-1].(*ast.IfStmt); ok && p.Else == ast.Stmt(t) {
				return Step{}, false
			}
		}
		return Step{line(t.If), "if"}, true
	case *ast.ForStmt:
		return Step{line(t.For), "for"}, true
	case *ast.RangeStmt:
		return Step{line(t.For), "for"}, true
	case *ast.SwitchStmt:
		return Step{line(t.Switch), "switch"}, true
	case *ast.TypeSwitchStmt:
		return Step{line(t.Switch), "switch"}, true
	case *ast.SelectStmt:
		return Step{line(t.Select), "select"}, true
	}
	return Step{}, false
}

// Range is an inclusive head-side line range.
type Range struct{ Start, End int }

// ownLine reports whether line l belongs to fn's own code: inside its range
// and not strictly inside a nested closure. A closure's first and last lines
// are shared with the enclosing function.
func ownLine(fn *Func, l int) bool {
	if l < fn.Start || l > fn.End {
		return false
	}
	for _, c := range fn.Children {
		if l > c.Start && l < c.End {
			return false
		}
	}
	return true
}

// Classify returns "added" when every line of fn is changed, "modified" when
// some own line is changed, and "" when the function is untouched.
func Classify(fn *Func, changed map[int]bool) string {
	all := true
	touched := false
	for l := fn.Start; l <= fn.End; l++ {
		if !changed[l] {
			all = false
		} else if ownLine(fn, l) {
			touched = true
		}
	}
	if all {
		return "added"
	}
	if touched {
		return "modified"
	}
	return ""
}

func changedSet(ranges []Range) map[int]bool {
	set := map[int]bool{}
	for _, r := range ranges {
		for l := r.Start; l <= r.End; l++ {
			set[l] = true
		}
	}
	return set
}

func sortedPaths(m map[string][]Range) []string {
	out := make([]string, 0, len(m))
	for p := range m {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
