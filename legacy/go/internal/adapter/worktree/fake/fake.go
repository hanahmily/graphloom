// Package fake is the test Worktree adapter for reconcile tests without git.
package fake

import (
	"context"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Worktree records intents without invoking git.
type Worktree struct{}

func New() *Worktree { return &Worktree{} }

func (w *Worktree) Create(ctx context.Context, intent controller.WorktreeIntent) (controller.WorktreeInfo, error) {
	_ = ctx
	_ = intent
	return controller.WorktreeInfo{}, errNotImplemented
}

func (w *Worktree) Reconcile(ctx context.Context, intent controller.WorktreeIntent) (controller.WorktreeInfo, error) {
	_ = ctx
	_ = intent
	return controller.WorktreeInfo{}, errNotImplemented
}

func (w *Worktree) Verify(ctx context.Context, info controller.WorktreeInfo) error {
	_ = ctx
	_ = info
	return errNotImplemented
}

func (w *Worktree) Fingerprint(ctx context.Context, workRoot string) (controller.WorkspaceRevision, error) {
	_ = ctx
	_ = workRoot
	return "", errNotImplemented
}

var _ controller.Worktree = (*Worktree)(nil)
