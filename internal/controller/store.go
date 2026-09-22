package controller

import "context"

// Store is the durable run document under a host directory.
// MVP ships adapter/store/fs only; tests use t.TempDir().
type Store interface {
	// Transact loads the document under exclusive ownership, applies fn, and
	// commits with an atomic replace. Create the run on first Transact if needed.
	Transact(ctx context.Context, runID string, fn func(*Document) error) error
	Get(ctx context.Context, runID string) (*Document, error)
	EnqueueCommand(ctx context.Context, runID string, cmd RunCommand) error
}

// Document is the versioned run state held by Store.
type Document struct {
	RunID string
	// Further fields land with persistence implementation.
}

// RunCommand is an inbox request (stop) that does not require the write lock
// of the active controller process.
type RunCommand struct {
	ID   string
	Kind string // "stop" for MVP
}
