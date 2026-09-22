// Package scripted is the test Runner adapter with canned observations.
package scripted

import (
	"context"
	"fmt"
	"sync"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Step is one canned observation consumed in order for matching roles,
// or for any role when Role is empty.
type Step struct {
	Role        controller.Role
	Observation controller.Observation
	Err         error
}

// Runner maps sequential steps to Invoke calls.
type Runner struct {
	mu    sync.Mutex
	steps []Step
	i     int
}

func New(steps []Step) *Runner {
	cp := append([]Step(nil), steps...)
	return &Runner{steps: cp}
}

func (r *Runner) Invoke(ctx context.Context, job controller.Job) (controller.Observation, error) {
	_ = ctx
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.i >= len(r.steps) {
		return controller.Observation{}, fmt.Errorf("scripted: no step left for role %s node %s", job.Role, job.NodeID)
	}
	step := r.steps[r.i]
	if step.Role != "" && step.Role != job.Role {
		return controller.Observation{}, fmt.Errorf("scripted: expected role %s, got %s", step.Role, job.Role)
	}
	r.i++
	if step.Err != nil {
		return controller.Observation{}, step.Err
	}
	return step.Observation, nil
}

var _ controller.Runner = (*Runner)(nil)
