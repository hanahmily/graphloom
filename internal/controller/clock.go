package controller

import "time"

// Clock supplies wall time for budgets and deadlines.
type Clock interface {
	Now() time.Time
}
