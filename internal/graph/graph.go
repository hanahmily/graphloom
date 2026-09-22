// Package graph is the pure advancer: readiness, acceptance, reentry, completion.
// It must not import subprocess, provider, or storage packages.
package graph

// State is the in-memory intent graph, execution nodes, and current receipts.
type State struct {
	// Intentionally empty in the scaffold; filled as types land.
}

// Transition is exactly one admitted graph effect.
type Transition struct {
	Append  *AppendSpec
	Accept  *AcceptSpec
	Reenter *ReenterSpec
	Observe *ObserveSpec
}

type AppendSpec struct{}
type AcceptSpec struct{}
type ReenterSpec struct{}
type ObserveSpec struct{}

// Info is the pure readiness / completion view of State.
type Info struct {
	ReadyNode *NodeID
	Complete  bool
	Blocked   bool
}

type NodeID string

// Apply admits one transition or returns a rejection. Pure; no I/O.
func Apply(s State, t Transition) (State, error) {
	return s, errNotImplemented
}

// Ready reports the earliest ready node, or blocked/complete. Pure; no I/O.
func Ready(s State) Info {
	return Info{}
}

// Complete is true when every happy-path stage has a currently valid receipt.
func Complete(s State) bool {
	return false
}
