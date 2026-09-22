// Package fake is the test Clock adapter with manual time control.
package fake

import (
	"sync"
	"time"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Clock is a mutable test clock.
type Clock struct {
	mu  sync.Mutex
	now time.Time
}

func New(now time.Time) *Clock { return &Clock{now: now} }

func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

var _ controller.Clock = (*Clock)(nil)
