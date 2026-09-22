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
	Stages         Stages               `json:"stages"`
	Active         bool                 `json:"active"`
	Epoch          uint64               `json:"epoch"`
	Nodes          []Node               `json:"nodes"`
	Receipts       map[StageID]Receipt  `json:"receipts"`
	ReceiptHistory []Receipt            `json:"receipt_history"`
}

// Node is one append-only execution operation.
type Node struct {
	ID        NodeID     `json:"id"`
	Stage     StageID    `json:"stage,omitempty"` // empty only for bootstrap plan review
	Kind      Kind       `json:"kind"`
	Purpose   Purpose    `json:"purpose"`
	After     []NodeID   `json:"after,omitempty"`
	Requires  []ReceiptID `json:"requires,omitempty"`
	Status    NodeStatus `json:"status"`
	Bootstrap bool       `json:"bootstrap,omitempty"` // plan-review exception
	Epoch     uint64     `json:"epoch"`
	Argv      []string   `json:"argv,omitempty"` // command nodes
	Outcome   *Outcome   `json:"outcome,omitempty"`
}

// Outcome is recorded when a node is observed (including failures).
type Outcome struct {
	OK             bool        `json:"ok"`
	Fingerprint    Fingerprint `json:"fingerprint,omitempty"`
	CheckPassed    bool        `json:"check_passed,omitempty"`
	ReviewApproved bool        `json:"review_approved,omitempty"`
}

// Receipt is accepted stage evidence. Invalid receipts stay in history.
type Receipt struct {
	ID          ReceiptID   `json:"id"`
	Stage       StageID     `json:"stage"`
	Fingerprint Fingerprint `json:"fingerprint"`
	Valid       bool        `json:"valid"`
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
	Status         NodeStatus // running, observed, interrupted, or cancelled
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

// Node returns a deep copy of the named node, or nil.
func (s State) Node(id NodeID) *Node {
	for i := range s.Nodes {
		if s.Nodes[i].ID == id {
			n := copyNode(s.Nodes[i])
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
	// MVP is serial: nothing else may be ready while a job is running.
	if hasRunning(s) {
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
		if n.Bootstrap {
			if n.Stage != "" {
				return s, rejectf("bootstrap node %q must not set a stage", n.ID)
			}
		} else if n.Stage == "" {
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
		nn.Epoch = s.Epoch
		if nn.Argv != nil {
			nn.Argv = append([]string(nil), nn.Argv...)
		}
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
	case StatusRunning, StatusObserved, StatusInterrupted, StatusCancelled:
		// ok
	default:
		return s, rejectf("invalid observe status %q", spec.Status)
	}
	if n.Status == StatusPending && spec.Status != StatusCancelled {
		// Pending work may only start/settle when it is the ready node.
		if !ready(s, n) {
			return s, rejectf("node %q is not ready", spec.NodeID)
		}
		if spec.Status == StatusRunning && hasRunning(s) {
			return s, rejectf("another node is already running")
		}
	}
	if n.Status == StatusRunning && spec.Status == StatusRunning {
		return s, rejectf("node %q already running", spec.NodeID)
	}
	if n.Status == StatusPending && spec.Status == StatusCancelled {
		// Cancellation of a non-ready pending node is allowed.
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
	if receiptIDExists(s, spec.ReceiptID) {
		return s, rejectf("duplicate receipt id %q", spec.ReceiptID)
	}
	if cur, ok := s.Receipts[spec.Stage]; ok && cur.Valid {
		return s, rejectf("stage %q already has a valid receipt", spec.Stage)
	}
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
	if !plan.Bootstrap || plan.Stage != "" {
		return s, rejectf("plan review must be a bootstrap node")
	}

	check := s.Node(spec.CheckNodeID)
	if check == nil || check.Status != StatusObserved || check.Outcome == nil {
		return s, rejectf("check evidence missing")
	}
	if check.Purpose != PurposeCheck {
		return s, rejectf("check evidence must have purpose check")
	}
	if check.Stage != spec.Stage && !stageBefore(s.Stages, check.Stage, spec.Stage) {
		return s, rejectf("check evidence does not support stage %q", spec.Stage)
	}
	if check.Epoch != s.Epoch {
		return s, rejectf("check evidence is from a prior epoch")
	}
	if !check.Outcome.OK || !check.Outcome.CheckPassed {
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
		if rev == nil || rev.Status != StatusObserved || rev.Outcome == nil {
			return s, rejectf("review evidence missing")
		}
		if rev.Purpose != PurposeReview || rev.Stage != spec.Stage {
			return s, rejectf("review evidence does not support stage %q", spec.Stage)
		}
		if rev.Epoch != s.Epoch {
			return s, rejectf("review evidence is from a prior epoch")
		}
		if !rev.Outcome.OK || !rev.Outcome.ReviewApproved {
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
	idx := -1
	for i, stage := range s.Stages {
		if stage == spec.Stage {
			idx = i
			break
		}
	}
	out := cloneState(s)
	out.Epoch++
	invalidated := map[ReceiptID]struct{}{}
	for i := idx; i < len(s.Stages); i++ {
		stage := s.Stages[i]
		if r, ok := out.Receipts[stage]; ok {
			r.Valid = false
			out.Receipts[stage] = r
			invalidated[r.ID] = struct{}{}
			for j := range out.ReceiptHistory {
				if out.ReceiptHistory[j].ID == r.ID {
					out.ReceiptHistory[j].Valid = false
				}
			}
		}
	}
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
	if n.Stage != earliest {
		return false
	}
	return true
}

func hasRunning(s State) bool {
	for i := range s.Nodes {
		if s.Nodes[i].Status == StatusRunning {
			return true
		}
	}
	return false
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

func receiptIDExists(s State, id ReceiptID) bool {
	for _, r := range s.ReceiptHistory {
		if r.ID == id {
			return true
		}
	}
	for _, r := range s.Receipts {
		if r.ID == id {
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

// stageBefore reports whether a appears before b in the happy path.
func stageBefore(stages Stages, a, b StageID) bool {
	ai, bi := -1, -1
	for i, s := range stages {
		if s == a {
			ai = i
		}
		if s == b {
			bi = i
		}
	}
	return ai >= 0 && bi >= 0 && ai < bi
}

func nodeIndex(s State, id NodeID) int {
	for i := range s.Nodes {
		if s.Nodes[i].ID == id {
			return i
		}
	}
	return -1
}

func copyNode(n Node) Node {
	out := n
	if n.Outcome != nil {
		oc := *n.Outcome
		out.Outcome = &oc
	}
	if n.After != nil {
		out.After = append([]NodeID(nil), n.After...)
	}
	if n.Requires != nil {
		out.Requires = append([]ReceiptID(nil), n.Requires...)
	}
	if n.Argv != nil {
		out.Argv = append([]string(nil), n.Argv...)
	}
	return out
}

func cloneState(s State) State {
	out := State{
		Stages:         append(Stages(nil), s.Stages...),
		Active:         s.Active,
		Epoch:          s.Epoch,
		Nodes:          make([]Node, len(s.Nodes)),
		Receipts:       make(map[StageID]Receipt, len(s.Receipts)),
		ReceiptHistory: append([]Receipt(nil), s.ReceiptHistory...),
	}
	for k, v := range s.Receipts {
		out.Receipts[k] = v
	}
	for i := range s.Nodes {
		out.Nodes[i] = copyNode(s.Nodes[i])
	}
	return out
}

func rejectf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrReject, fmt.Sprintf(format, args...))
}
