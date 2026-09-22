// Package graph is the pure advancer: readiness, acceptance, reentry, completion.
// It must not import subprocess, provider, or storage packages.
package graph

import (
	"errors"
	"fmt"
)

// ErrReject means Apply refused a transition for policy or schema reasons.
var ErrReject = errors.New("graph rejected transition")

// Stages is the immutable happy-path order.
type Stages []StageID

type StageID string
type NodeID string
type ReceiptID string
type Fingerprint string

type Kind string

const (
	KindAgent   Kind = "agent"
	KindCommand Kind = "command"
)

type Purpose string

const (
	PurposeWork   Purpose = "work"
	PurposeCheck  Purpose = "check"
	PurposeReview Purpose = "review"
)

type NodeStatus string

const (
	StatusPending     NodeStatus = "pending"
	StatusRunning     NodeStatus = "running"
	StatusObserved    NodeStatus = "observed"
	StatusInterrupted NodeStatus = "interrupted"
	StatusCancelled   NodeStatus = "cancelled"
)

// State is the in-memory intent graph, execution nodes, and current receipts.
type State struct {
	Stages         Stages
	Active         bool
	Nodes          []Node
	Receipts       map[StageID]Receipt // current receipt per stage (may be invalid)
	ReceiptHistory []Receipt           // all receipts ever issued, including invalidated
}

// Node is one append-only execution operation.
type Node struct {
	ID        NodeID
	Stage     StageID // empty only for bootstrap plan review
	Kind      Kind
	Purpose   Purpose
	After     []NodeID
	Requires  []ReceiptID
	Status    NodeStatus
	Bootstrap bool // plan-review exception: eligible before any stage receipt
	Outcome   *Outcome
}

// Outcome is recorded when a node is observed (including failures).
type Outcome struct {
	OK             bool
	Fingerprint    Fingerprint
	CheckPassed    bool
	ReviewApproved bool
}

// Receipt is accepted stage evidence. Invalid receipts stay in history.
type Receipt struct {
	ID          ReceiptID
	Stage       StageID
	Fingerprint Fingerprint
	Valid       bool
}

// Transition is exactly one admitted graph effect.
type Transition struct {
	Append  *AppendSpec
	Accept  *AcceptSpec
	Reenter *ReenterSpec
	Observe *ObserveSpec
}

type AppendSpec struct {
	Nodes []Node
}

type AcceptSpec struct {
	Stage            StageID
	ReceiptID        ReceiptID
	Fingerprint      Fingerprint
	PlanReviewNodeID NodeID
	CheckNodeID      NodeID
	ReviewNodeID     NodeID // required for non-first stages
}

type ReenterSpec struct {
	Stage StageID
}

type ObserveSpec struct {
	NodeID         NodeID
	Status         NodeStatus // observed, interrupted, or cancelled
	OK             bool
	Fingerprint    Fingerprint
	CheckPassed    bool
	ReviewApproved bool
}

// Info is the pure readiness / completion view of State.
type Info struct {
	ReadyNode *NodeID
	Complete  bool
	Blocked   bool
}

// New returns an active run state for the given happy path.
func New(stages Stages) State {
	cp := make(Stages, len(stages))
	copy(cp, stages)
	return State{
		Stages:   cp,
		Active:   true,
		Receipts: map[StageID]Receipt{},
	}
}

// Node returns a copy of the named node, or nil.
func (s State) Node(id NodeID) *Node {
	for i := range s.Nodes {
		if s.Nodes[i].ID == id {
			n := s.Nodes[i]
			return &n
		}
	}
	return nil
}

// Receipt returns the current receipt for a stage, or nil.
func (s State) Receipt(stage StageID) *Receipt {
	r, ok := s.Receipts[stage]
	if !ok {
		return nil
	}
	cp := r
	return &cp
}

// Apply admits one transition or returns a rejection. Pure; no I/O.
func Apply(s State, t Transition) (State, error) {
	n := 0
	if t.Append != nil {
		n++
	}
	if t.Accept != nil {
		n++
	}
	if t.Reenter != nil {
		n++
	}
	if t.Observe != nil {
		n++
	}
	if n != 1 {
		return s, rejectf("exactly one transition field required")
	}
	switch {
	case t.Append != nil:
		return applyAppend(s, *t.Append)
	case t.Accept != nil:
		return applyAccept(s, *t.Accept)
	case t.Reenter != nil:
		return applyReenter(s, *t.Reenter)
	default:
		return applyObserve(s, *t.Observe)
	}
}

// Ready reports the earliest ready node, or blocked/complete. Pure; no I/O.
func Ready(s State) Info {
	if Complete(s) {
		return Info{Complete: true}
	}
	if !s.Active {
		return Info{Blocked: true}
	}
	for i := range s.Nodes {
		n := s.Nodes[i]
		if ready(s, n) {
			id := n.ID
			return Info{ReadyNode: &id}
		}
	}
	return Info{Blocked: true}
}

// Complete is true when every happy-path stage has a currently valid receipt.
func Complete(s State) bool {
	if len(s.Stages) == 0 {
		return false
	}
	for _, stage := range s.Stages {
		r, ok := s.Receipts[stage]
		if !ok || !r.Valid {
			return false
		}
	}
	return true
}

func applyAppend(s State, spec AppendSpec) (State, error) {
	if len(spec.Nodes) == 0 {
		return s, rejectf("append requires at least one node")
	}
	existing := map[NodeID]struct{}{}
	for _, n := range s.Nodes {
		existing[n.ID] = struct{}{}
	}
	batch := map[NodeID]struct{}{}
	out := cloneState(s)
	for _, n := range spec.Nodes {
		if n.ID == "" {
			return s, rejectf("node id required")
		}
		if _, ok := existing[n.ID]; ok {
			return s, rejectf("duplicate node id %q", n.ID)
		}
		if _, ok := batch[n.ID]; ok {
			return s, rejectf("duplicate node id %q in append", n.ID)
		}
		if n.Kind != KindAgent && n.Kind != KindCommand {
			return s, rejectf("invalid kind %q", n.Kind)
		}
		if !n.Bootstrap && n.Stage == "" {
			return s, rejectf("node %q missing stage", n.ID)
		}
		if n.Stage != "" && !knownStage(s.Stages, n.Stage) {
			return s, rejectf("unknown stage %q", n.Stage)
		}
		for _, dep := range n.After {
			if _, ok := existing[dep]; !ok {
				if _, ok := batch[dep]; !ok {
					return s, rejectf("unknown after %q", dep)
				}
			}
		}
		for _, rid := range n.Requires {
			// Receipt ids may be forward references; readiness waits until valid.
			if rid == "" {
				return s, rejectf("empty requires on %q", n.ID)
			}
		}
		nn := n
		if nn.Status == "" {
			nn.Status = StatusPending
		}
		if nn.Status != StatusPending {
			return s, rejectf("appended node %q must start pending", n.ID)
		}
		nn.Outcome = nil
		out.Nodes = append(out.Nodes, nn)
		batch[n.ID] = struct{}{}
	}
	return out, nil
}

func applyObserve(s State, spec ObserveSpec) (State, error) {
	idx := nodeIndex(s, spec.NodeID)
	if idx < 0 {
		return s, rejectf("unknown node %q", spec.NodeID)
	}
	n := s.Nodes[idx]
	switch n.Status {
	case StatusPending, StatusRunning:
		// ok
	default:
		return s, rejectf("node %q not pending/running", spec.NodeID)
	}
	switch spec.Status {
	case StatusObserved, StatusInterrupted, StatusCancelled:
		// ok
	default:
		return s, rejectf("invalid observe status %q", spec.Status)
	}
	out := cloneState(s)
	out.Nodes[idx].Status = spec.Status
	if spec.Status == StatusObserved || spec.Status == StatusInterrupted {
		out.Nodes[idx].Outcome = &Outcome{
			OK:             spec.OK,
			Fingerprint:    spec.Fingerprint,
			CheckPassed:    spec.CheckPassed,
			ReviewApproved: spec.ReviewApproved,
		}
	}
	return out, nil
}

func applyAccept(s State, spec AcceptSpec) (State, error) {
	if !knownStage(s.Stages, spec.Stage) {
		return s, rejectf("unknown stage %q", spec.Stage)
	}
	if spec.ReceiptID == "" {
		return s, rejectf("receipt id required")
	}
	if cur, ok := s.Receipts[spec.Stage]; ok && cur.Valid {
		return s, rejectf("stage %q already has a valid receipt", spec.Stage)
	}
	// Must be the earliest unaccepted stage.
	for _, stage := range s.Stages {
		if stage == spec.Stage {
			break
		}
		r, ok := s.Receipts[stage]
		if !ok || !r.Valid {
			return s, rejectf("cannot accept %q before %q", spec.Stage, stage)
		}
	}

	plan := s.Node(spec.PlanReviewNodeID)
	if plan == nil || plan.Status != StatusObserved || plan.Outcome == nil || !plan.Outcome.OK {
		return s, rejectf("plan review evidence missing or not OK")
	}
	check := s.Node(spec.CheckNodeID)
	if check == nil || check.Status != StatusObserved || check.Outcome == nil {
		return s, rejectf("check evidence missing")
	}
	if !check.Outcome.CheckPassed {
		return s, rejectf("check did not pass")
	}
	if check.Outcome.Fingerprint != spec.Fingerprint {
		return s, rejectf("stale check fingerprint")
	}

	first := s.Stages[0]
	if spec.Stage == first {
		if spec.ReviewNodeID != "" {
			return s, rejectf("first-stage accept must not cite a review node")
		}
	} else {
		rev := s.Node(spec.ReviewNodeID)
		if rev == nil || rev.Status != StatusObserved || rev.Outcome == nil || !rev.Outcome.ReviewApproved {
			return s, rejectf("review evidence missing or not approved")
		}
		if rev.Outcome.Fingerprint != spec.Fingerprint {
			return s, rejectf("stale review fingerprint")
		}
		for _, stage := range s.Stages {
			if stage == spec.Stage {
				break
			}
			r, ok := s.Receipts[stage]
			if !ok || !r.Valid {
				return s, rejectf("predecessor %q receipt invalid", stage)
			}
			if r.Fingerprint != spec.Fingerprint {
				return s, rejectf("predecessor %q fingerprint mismatch", stage)
			}
		}
	}

	out := cloneState(s)
	rcpt := Receipt{
		ID:          spec.ReceiptID,
		Stage:       spec.Stage,
		Fingerprint: spec.Fingerprint,
		Valid:       true,
	}
	out.Receipts[spec.Stage] = rcpt
	out.ReceiptHistory = append(out.ReceiptHistory, rcpt)
	return out, nil
}

func applyReenter(s State, spec ReenterSpec) (State, error) {
	if !knownStage(s.Stages, spec.Stage) {
		return s, rejectf("unknown stage %q", spec.Stage)
	}
	// Find stage index; invalidate this and all later receipts.
	idx := -1
	for i, stage := range s.Stages {
		if stage == spec.Stage {
			idx = i
			break
		}
	}
	out := cloneState(s)
	invalidated := map[ReceiptID]struct{}{}
	for i := idx; i < len(s.Stages); i++ {
		stage := s.Stages[i]
		if r, ok := out.Receipts[stage]; ok {
			r.Valid = false
			out.Receipts[stage] = r
			invalidated[r.ID] = struct{}{}
			// Keep history entries; mark matching history as invalid too.
			for j := range out.ReceiptHistory {
				if out.ReceiptHistory[j].ID == r.ID {
					out.ReceiptHistory[j].Valid = false
				}
			}
		}
	}
	// Cancel pending/running nodes that require an invalidated receipt.
	for i := range out.Nodes {
		n := &out.Nodes[i]
		if n.Status != StatusPending && n.Status != StatusRunning {
			continue
		}
		for _, rid := range n.Requires {
			if _, hit := invalidated[rid]; hit {
				n.Status = StatusCancelled
				break
			}
		}
	}
	return out, nil
}

func ready(s State, n Node) bool {
	if n.Status != StatusPending {
		return false
	}
	for _, dep := range n.After {
		d := s.Node(dep)
		if d == nil {
			return false
		}
		// Dependency means observation available, not success.
		if d.Status != StatusObserved && d.Status != StatusInterrupted {
			return false
		}
	}
	for _, rid := range n.Requires {
		if !validReceiptID(s, rid) {
			return false
		}
	}
	if n.Bootstrap {
		return true
	}
	earliest := earliestUnaccepted(s)
	if earliest == "" {
		return false
	}
	// Node must support the earliest unaccepted stage (or be bootstrap).
	if n.Stage != earliest {
		return false
	}
	return true
}

func earliestUnaccepted(s State) StageID {
	for _, stage := range s.Stages {
		r, ok := s.Receipts[stage]
		if !ok || !r.Valid {
			return stage
		}
	}
	return ""
}

func validReceiptID(s State, id ReceiptID) bool {
	for _, r := range s.Receipts {
		if r.ID == id && r.Valid {
			return true
		}
	}
	return false
}

func knownStage(stages Stages, id StageID) bool {
	for _, s := range stages {
		if s == id {
			return true
		}
	}
	return false
}

func nodeIndex(s State, id NodeID) int {
	for i := range s.Nodes {
		if s.Nodes[i].ID == id {
			return i
		}
	}
	return -1
}

func cloneState(s State) State {
	out := State{
		Stages:         append(Stages(nil), s.Stages...),
		Active:         s.Active,
		Nodes:          append([]Node(nil), s.Nodes...),
		Receipts:       make(map[StageID]Receipt, len(s.Receipts)),
		ReceiptHistory: append([]Receipt(nil), s.ReceiptHistory...),
	}
	for k, v := range s.Receipts {
		out.Receipts[k] = v
	}
	// Deep-copy outcomes so mutations don't alias.
	for i := range out.Nodes {
		if out.Nodes[i].Outcome != nil {
			oc := *out.Nodes[i].Outcome
			out.Nodes[i].Outcome = &oc
		}
		if out.Nodes[i].After != nil {
			out.Nodes[i].After = append([]NodeID(nil), out.Nodes[i].After...)
		}
		if out.Nodes[i].Requires != nil {
			out.Nodes[i].Requires = append([]ReceiptID(nil), out.Nodes[i].Requires...)
		}
	}
	return out
}

func rejectf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrReject, fmt.Sprintf(format, args...))
}
