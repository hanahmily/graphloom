// Package scripted is the test Runner adapter with canned observations.
package scripted

import (
	"context"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Runner maps job identities to scripted observations.
type Runner struct{}

func New() *Runner { return &Runner{} }

func (r *Runner) Invoke(ctx context.Context, job controller.Job) (controller.Observation, error) {
	_ = ctx
	_ = job
	return controller.Observation{}, errNotImplemented
}

var _ controller.Runner = (*Runner)(nil)
