// Package system is the production Clock adapter.
package system

import (
	"time"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Clock returns wall time from the host.
type Clock struct{}

func New() Clock { return Clock{} }

func (Clock) Now() time.Time { return time.Now() }

var _ controller.Clock = Clock{}
