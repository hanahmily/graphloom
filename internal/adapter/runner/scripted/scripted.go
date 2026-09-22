// Package scripted is the test Runner adapter with canned observations.
package scripted

import (
	"context"
	"encoding/json"
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
	mu        sync.Mutex
	steps     []Step
	i         int
	autoFence bool
}

func New(steps []Step) *Runner {
	cp := append([]Step(nil), steps...)
	return &Runner{steps: cp, autoFence: true}
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
	obs := step.Observation
	if r.autoFence && job.Role == controller.RoleSupervisor && len(job.Packet) > 0 && len(obs.ResultRaw) > 0 {
		patched, err := injectFence(job.Packet, obs.ResultRaw)
		if err != nil {
			return controller.Observation{}, err
		}
		obs.ResultRaw = patched
	}
	return obs, nil
}

func injectFence(packet, decision []byte) ([]byte, error) {
	var view struct {
		RunID      string `json:"run_id"`
		Generation uint64 `json:"generation"`
		Revision   uint64 `json:"revision"`
	}
	if err := json.Unmarshal(packet, &view); err != nil {
		return nil, fmt.Errorf("scripted: packet: %w", err)
	}
	var dec map[string]any
	if err := json.Unmarshal(decision, &dec); err != nil {
		return nil, fmt.Errorf("scripted: decision: %w", err)
	}
	dec["run_id"] = view.RunID
	dec["generation"] = view.Generation
	dec["expected_revision"] = view.Revision
	return json.Marshal(dec)
}

var _ controller.Runner = (*Runner)(nil)
