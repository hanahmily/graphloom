package corpus

import (
	"errors"
	"fmt"
	"strings"
)

type Store struct {
	items map[string]int
	limit int
}

type Pair[K comparable, V any] struct {
	Key K
	Val V
}

func Empty() {}

func Straight(a, b int) int {
	c := a + b
	return c * 2
}

func Branches(n int) string {
	if n < 0 {
		return "neg"
	} else if n == 0 {
		return "zero"
	} else if n < 10 {
		return "small"
	} else {
		return "big"
	}
}

func Loops(xs []int, m map[string]int) int {
	total := 0
	for i := 0; i < len(xs); i++ {
		total += xs[i]
	}
	for _, x := range xs {
		total += x
	}
	for k := range m {
		total += len(k)
	}
	for total > 100 {
		total /= 2
	}
	for {
		break
	}
	return total
}

func Switchy(x int) string {
	switch x {
	case 1:
		return "one"
	case 2, 3:
		return "few"
	case 4:
		fallthrough
	case 5:
		return "some"
	default:
		return "many"
	}
}

func TypeSwitch(v interface{}) string {
	switch t := v.(type) {
	case int:
		return fmt.Sprint(t)
	case string:
		return t
	case nil:
		return "nil"
	default:
		return "?"
	}
}

func Selecty(a, b chan int, done chan struct{}) int {
	select {
	case v := <-a:
		return v
	case w := <-b:
		return w
	case <-done:
		return -1
	default:
		return 0
	}
}

func Logic(a, b, c, d bool) bool {
	if a && b || c && d {
		return true
	}
	return a || b || c
}

func (s *Store) Get(key string) (int, error) {
	if s == nil || s.items == nil {
		return 0, errors.New("no store")
	}
	v, ok := s.items[key]
	if !ok {
		return 0, fmt.Errorf("missing %q", key)
	}
	return v, nil
}

func (s Store) Limit() int {
	return s.limit
}

func (p *Pair[K, V]) Swap(other Pair[K, V]) bool {
	return p.Key == other.Key && any(p.Val) == any(other.Val)
}

func Map[T, U any](xs []T, f func(T) U) []U {
	out := make([]U, 0, len(xs))
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}

func Deep(xs [][]int, want int) (int, bool) {
	for i, row := range xs {
		for j, v := range row {
			if v == want {
				switch {
				case i == j:
					return i, true
				case i > j:
					return j, true
				}
			}
		}
	}
	return 0, false
}

func Words(s string) int {
	n := 0
	for _, w := range strings.Fields(s) {
		if len(w) > 3 && w != "stop" {
			n++
		}
	}
	return n
}

func initOnce(flag *bool) {
	if flag != nil {
		if *flag {
			return
		}
		*flag = true
	}
}
