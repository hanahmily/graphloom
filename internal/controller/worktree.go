package controller

import "context"

// Worktree creates and reconciles the isolated Git worktree for a run.
type Worktree interface {
	Create(ctx context.Context, intent WorktreeIntent) (WorktreeInfo, error)
	Reconcile(ctx context.Context, intent WorktreeIntent) (WorktreeInfo, error)
	Verify(ctx context.Context, info WorktreeInfo) error
	Fingerprint(ctx context.Context, workRoot string) (WorkspaceRevision, error)
}

type WorktreeIntent struct {
	RunID      string
	SourceRepo string
	BaseCommit string
	Branch     string
	Path       string
}

type WorktreeInfo struct {
	Path       string
	Branch     string
	BaseCommit string
}

// WorkspaceRevision is a controller-issued content fingerprint (e.g. ws:N).
type WorkspaceRevision string
