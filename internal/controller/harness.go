package controller

import (
	"context"
	"errors"
)

// Outcome is the terminal or intermediate result of Run / Resume.
type Outcome struct {
	RunID    string
	Status   string
	Worktree string
}

// Report is the inspect projection.
type Report struct {
	RunID    string
	Status   string
	Worktree string
}

// Option configures harness wiring. Defaults select production adapters.
type Option func(*config)

type config struct {
	Runner   Runner
	Store    Store
	Worktree Worktree
	Clock    Clock
	RunRoot  string
}

func WithRunner(r Runner) Option {
	return func(c *config) { c.Runner = r }
}

func WithStore(s Store) Option {
	return func(c *config) { c.Store = s }
}

func WithWorktree(w Worktree) Option {
	return func(c *config) { c.Worktree = w }
}

func WithClock(clk Clock) Option {
	return func(c *config) { c.Clock = clk }
}

func WithRunRoot(dir string) Option {
	return func(c *config) { c.RunRoot = dir }
}

// Run starts a new run from task.yaml.
func Run(ctx context.Context, taskPath string, opts ...Option) (*Outcome, error) {
	_ = ctx
	_ = taskPath
	_ = applyOptions(opts)
	return nil, errNotImplemented
}

// Inspect reports durable run state and worktree identity.
func Inspect(ctx context.Context, runID string, opts ...Option) (*Report, error) {
	_ = ctx
	_ = runID
	_ = applyOptions(opts)
	return nil, errNotImplemented
}

// Stop requests a durable stop for an active run.
func Stop(ctx context.Context, runID string, opts ...Option) error {
	_ = ctx
	_ = runID
	_ = applyOptions(opts)
	return errNotImplemented
}

// Resume continues a stopped or interrupted run.
func Resume(ctx context.Context, runID string, opts ...Option) (*Outcome, error) {
	_ = ctx
	_ = runID
	_ = applyOptions(opts)
	return nil, errNotImplemented
}

func applyOptions(opts []Option) *config {
	c := &config{}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

var errNotImplemented = errors.New("controller: not implemented")
