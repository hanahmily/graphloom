// Package supervisor assembles supervisor views and decodes typed decisions.
// Session I/O uses controller.Runner; this package stays pure.
package supervisor

// Input is the durable facts needed to build a supervisor view.
type Input struct {
	// Intentionally empty in the scaffold.
}

// Prompt is the assembled view passed to a supervisor Runner turn.
type Prompt struct {
	Bytes []byte
}

// Decision is a typed supervisor action.
type Decision struct {
	RunID            string
	DecisionID       string
	Generation       uint64
	ExpectedRevision uint64
	Action           Action
	Reason           string
	EvidenceRefs     []string
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
	_ = in
	return Prompt{}, errNotImplemented
}

// ParseDecision types a runner payload into Decision. Pure.
func ParseDecision(raw []byte) (Decision, error) {
	_ = raw
	return Decision{}, errNotImplemented
}
