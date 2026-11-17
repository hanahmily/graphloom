package corpus

import "sort"

var defaultHandler = func(n int) int {
	if n > 0 {
		return n
	}
	return -n
}

func Sorted(xs []int, desc bool) []int {
	out := append([]int(nil), xs...)
	sort.Slice(out, func(i, j int) bool {
		if desc {
			return out[i] > out[j]
		}
		return out[i] < out[j]
	})
	return out
}

func Nested(items []string) func() int {
	count := 0
	return func() int {
		for _, it := range items {
			visit := func(s string) {
				if s != "" && len(s) > 2 {
					count++
				}
			}
			visit(it)
		}
		return count
	}
}

func TwoLiterals(a, b int) int {
	f := func(x int) int {
		if x > 0 {
			return x
		}
		return 0
	}
	g := func(x int) int { return x * 2 }
	if a > b {
		return f(a) + g(b)
	}
	return f(b)
}

func WithDefer(ok bool) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = nil
		}
	}()
	if !ok {
		panic("bad")
	}
	return nil
}
