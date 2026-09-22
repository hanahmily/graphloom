// Package fs is the durable filesystem Store adapter.
package fs

import (
	"context"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Store persists run state under a host directory tree.
type Store struct {
	Root string
}

func New(root string) *Store { return &Store{Root: root} }

func (s *Store) Transact(ctx context.Context, runID string, fn func(*controller.Document) error) error {
	_ = ctx
	_ = runID
	_ = fn
	return errNotImplemented
}

func (s *Store) Get(ctx context.Context, runID string) (*controller.Document, error) {
	_ = ctx
	_ = runID
	return nil, errNotImplemented
}

func (s *Store) EnqueueCommand(ctx context.Context, runID string, cmd controller.RunCommand) error {
	_ = ctx
	_ = runID
	_ = cmd
	return errNotImplemented
}

var _ controller.Store = (*Store)(nil)
