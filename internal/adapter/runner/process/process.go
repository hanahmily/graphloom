// Package process is the production Runner adapter (one installed agent backend).
package process

import (
	"context"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Runner is a placeholder production adapter.
type Runner struct{}

func New() *Runner { return &Runner{} }

func (r *Runner) Invoke(ctx context.Context, job controller.Job) (controller.Observation, error) {
	_ = ctx
	_ = job
	return controller.Observation{}, errNotImplemented
}

var _ controller.Runner = (*Runner)(nil)
