package supervisor

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Input is the durable facts needed to build a supervisor view.
type Input struct {
	RunID      string
	Generation uint64
	Revision   uint64
	Pinned     Pinned
	GraphJSON  []byte
}

// Pinned is the immutable intake snapshot visible to the supervisor.
type Pinned struct {
	GraphID     string   `json:"graph_id"`
	Request     string   `json:"request"`
	Stages      []string `json:"stages"`
	Definitions string   `json:"definitions"`
}

// Prompt is the assembled view passed to a supervisor Runner turn.
type Prompt struct {
	Bytes []byte
}

// Decision is a typed supervisor action.
type Decision struct {
	RunID            string   `json:"run_id"`
	DecisionID       string   `json:"decision_id"`
	Generation       uint64   `json:"generation"`
	ExpectedRevision uint64   `json:"expected_revision"`
	Action           Action   `json:"action"`
	Reason           string   `json:"reason"`
	EvidenceRefs     []string `json:"evidence_refs"`
	Nodes            []Node   `json:"nodes"`
}

// Node is an append payload node.
type Node struct {
	ID        string   `json:"id"`
	Stage     string   `json:"stage"`
	Kind      string   `json:"kind"`
	Purpose   string   `json:"purpose"`
	After     []string `json:"after"`
	Requires  []string `json:"requires"`
	Bootstrap bool     `json:"bootstrap"`
	Argv      []string `json:"argv"`
}

type Action string

const (
	ActionPlan    Action = "plan"
	ActionAppend  Action = "append"
	ActionAccept  Action = "accept"
	ActionReenter Action = "reenter"
	ActionStop    Action = "stop"
)

// BuildView packs pinned sources and current graph facts into a Prompt. Pure.
func BuildView(in Input) (Prompt, error) {
	type view struct {
		RunID      string          `json:"run_id"`
		Generation uint64          `json:"generation"`
		Revision   uint64          `json:"revision"`
		Pinned     Pinned          `json:"pinned"`
		Graph      json.RawMessage `json:"graph"`
	}
	v := view{
		RunID:      in.RunID,
		Generation: in.Generation,
		Revision:   in.Revision,
		Pinned:     in.Pinned,
	}
	if len(in.GraphJSON) > 0 {
		v.Graph = append(json.RawMessage(nil), in.GraphJSON...)
	} else {
		v.Graph = json.RawMessage("{}")
	}
	b, err := json.Marshal(v)
	if err != nil {
		return Prompt{}, err
	}
	return Prompt{Bytes: b}, nil
}

// ParseDecision types a runner payload into Decision. Pure.
func ParseDecision(raw []byte) (Decision, error) {
	if len(raw) == 0 {
		return Decision{}, fmt.Errorf("%w: empty decision", ErrMalformed)
	}
	var d Decision
	if err := json.Unmarshal(raw, &d); err != nil {
		return Decision{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	switch d.Action {
	case ActionPlan, ActionAppend, ActionAccept, ActionReenter, ActionStop:
		// ok
	default:
		return Decision{}, fmt.Errorf("%w: unknown action %q", ErrMalformed, d.Action)
	}
	if d.DecisionID == "" {
		return Decision{}, fmt.Errorf("%w: decision_id required", ErrMalformed)
	}
	if d.Action == ActionAppend && len(d.Nodes) == 0 {
		return Decision{}, fmt.Errorf("%w: append requires nodes", ErrMalformed)
	}
	return d, nil
}

// ErrMalformed means the decision payload could not be typed.
var ErrMalformed = errors.New("supervisor: malformed decision")
