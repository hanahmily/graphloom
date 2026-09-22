package controller

import "context"

// Store is the durable run document under a host directory.
// MVP ships adapter/store/fs only; tests use t.TempDir().
type Store interface {
	Transact(ctx context.Context, runID string, fn func(*Document) error) error
	Get(ctx context.Context, runID string) (*Document, error)
	EnqueueCommand(ctx context.Context, runID string, cmd RunCommand) error
}

// Document is the versioned run state held by Store.
type Document struct {
	RunID           string                `json:"run_id"`
	Status          string                `json:"status"` // active | stopped | succeeded | interrupted
	Generation      uint64                `json:"generation"`
	Revision        uint64                `json:"revision"`
	Pinned          PinnedIntake          `json:"pinned"`
	Graph           GraphState            `json:"graph"`
	Dispatching     *DispatchIntent       `json:"dispatching,omitempty"`
	Observations    []ObservationRecord   `json:"observations"`
	LastDecisionID  string                `json:"last_decision_id,omitempty"`
	FailureReason   string                `json:"failure_reason,omitempty"`
}

// DispatchIntent is persisted before Runner.Invoke so crashes can reconcile.
type DispatchIntent struct {
	NodeID string `json:"node_id"`
	Role   string `json:"role"`
}

// ObservationRecord is durable evidence for an observed execution node.
type ObservationRecord struct {
	NodeID      string `json:"node_id"`
	Status      string `json:"status"`
	ExitCode    *int   `json:"exit_code,omitempty"`
	OK          bool   `json:"ok"`
	EvidenceRef string `json:"evidence_ref"`
}

// PinnedIntake is the immutable task snapshot for a run.
type PinnedIntake struct {
	GraphID     string   `json:"graph_id"`
	RepoPath    string   `json:"repo_path"`
	Request     string   `json:"request"`
	Stages      []string `json:"stages"`
	Definitions string   `json:"definitions"`
	TaskDir     string   `json:"task_dir"`
}

// GraphState is the JSON-stable projection of graph.State used in Document.
type GraphState struct {
	Raw []byte `json:"raw"`
}

// RunCommand is an inbox request (stop) that does not require the write lock
// of the active controller process.
type RunCommand struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // "stop" for MVP
}
