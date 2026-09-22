package controller

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/hanahmily/graphloom/internal/graph"
	"github.com/hanahmily/graphloom/internal/supervisor"
)

// Outcome is the terminal or intermediate result of Run / Resume.
type Outcome struct {
	RunID    string
	Status   string
	Worktree string
}

// Report is the inspect projection.
type Report struct {
	RunID             string
	Status            string
	Worktree          string
	ObservedNodes     []string
	Observations      []ObservationRecord
	PinnedGraph       string
	PinnedRequest     string
	PinnedStages      []string
	PinnedDefinitions string
	FailureReason     string
}

// Option configures harness wiring. Defaults select production adapters.
type Option func(*config)

type config struct {
	Runner   Runner
	Store    Store
	Worktree Worktree
	Clock    Clock
	RunRoot  string
}

func WithRunner(r Runner) Option {
	return func(c *config) { c.Runner = r }
}

func WithStore(s Store) Option {
	return func(c *config) { c.Store = s }
}

func WithWorktree(w Worktree) Option {
	return func(c *config) { c.Worktree = w }
}

func WithClock(clk Clock) Option {
	return func(c *config) { c.Clock = clk }
}

func WithRunRoot(dir string) Option {
	return func(c *config) { c.RunRoot = dir }
}

// Run starts a new run from task.yaml.
func Run(ctx context.Context, taskPath string, opts ...Option) (*Outcome, error) {
	cfg, err := resolveConfig(opts, true)
	if err != nil {
		return nil, err
	}
	pinned, err := loadPinnedIntake(taskPath)
	if err != nil {
		return nil, err
	}
	runID, err := newRunID()
	if err != nil {
		return nil, err
	}
	stages := make(graph.Stages, len(pinned.Stages))
	for i, s := range pinned.Stages {
		stages[i] = graph.StageID(s)
	}
	gs := graph.New(stages)
	raw, err := encodeGraph(gs)
	if err != nil {
		return nil, err
	}
	err = cfg.Store.Transact(ctx, runID, func(doc *Document) error {
		doc.Status = "active"
		doc.Pinned = pinned
		doc.Graph = GraphState{Raw: raw}
		doc.Observations = nil
		doc.Dispatching = nil
		doc.Generation = 1
		doc.Revision = 1
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := runLoop(ctx, cfg, runID); err != nil {
		_ = markInterrupted(ctx, cfg.Store, runID, err.Error())
		return nil, err
	}
	doc, err := cfg.Store.Get(ctx, runID)
	if err != nil {
		return nil, err
	}
	return &Outcome{RunID: runID, Status: doc.Status}, nil
}

// Inspect reports durable run state and worktree identity.
func Inspect(ctx context.Context, runID string, opts ...Option) (*Report, error) {
	cfg, err := resolveConfig(opts, false)
	if err != nil {
		return nil, err
	}
	doc, err := cfg.Store.Get(ctx, runID)
	if err != nil {
		return nil, err
	}
	nodes := make([]string, 0, len(doc.Observations))
	for _, o := range doc.Observations {
		nodes = append(nodes, o.NodeID)
	}
	return &Report{
		RunID:             doc.RunID,
		Status:            doc.Status,
		ObservedNodes:     nodes,
		Observations:      append([]ObservationRecord(nil), doc.Observations...),
		PinnedGraph:       doc.Pinned.GraphID,
		PinnedRequest:     doc.Pinned.Request,
		PinnedStages:      append([]string(nil), doc.Pinned.Stages...),
		PinnedDefinitions: doc.Pinned.Definitions,
		FailureReason:     doc.FailureReason,
	}, nil
}

// Stop requests a durable stop for an active run.
func Stop(ctx context.Context, runID string, opts ...Option) error {
	_ = ctx
	_ = runID
	_ = applyOptions(opts)
	return errNotImplemented
}

// Resume continues a stopped or interrupted run.
func Resume(ctx context.Context, runID string, opts ...Option) (*Outcome, error) {
	_ = ctx
	_ = runID
	_ = applyOptions(opts)
	return nil, errNotImplemented
}

func runLoop(ctx context.Context, cfg *config, runID string) error {
	for {
		doc, err := cfg.Store.Get(ctx, runID)
		if err != nil {
			return err
		}
		if doc.Status != "active" {
			return nil
		}
		gs, err := decodeGraph(doc.Graph)
		if err != nil {
			return err
		}
		info := graph.Ready(gs)
		if info.Complete {
			return cfg.Store.Transact(ctx, runID, func(d *Document) error {
				d.Status = "succeeded"
				d.Revision++
				return nil
			})
		}
		if info.ReadyNode != nil {
			if err := dispatchReady(ctx, cfg, runID, *info.ReadyNode); err != nil {
				return err
			}
			continue
		}
		if err := consultSupervisor(ctx, cfg, runID); err != nil {
			return err
		}
	}
}

func dispatchReady(ctx context.Context, cfg *config, runID string, nodeID graph.NodeID) error {
	doc, err := cfg.Store.Get(ctx, runID)
	if err != nil {
		return err
	}
	gs, err := decodeGraph(doc.Graph)
	if err != nil {
		return err
	}
	n := gs.Node(nodeID)
	if n == nil {
		return fmt.Errorf("controller: missing ready node %s", nodeID)
	}
	if err := validatePathComponent(string(nodeID), "node id"); err != nil {
		return err
	}
	role := RoleCommand
	switch n.Kind {
	case graph.KindAgent:
		if n.Purpose == graph.PurposeReview {
			role = RoleReviewer
		} else {
			role = RoleWorker
		}
	case graph.KindCommand:
		role = RoleCommand
	}

	err = cfg.Store.Transact(ctx, runID, func(d *Document) error {
		d.Dispatching = &DispatchIntent{NodeID: string(nodeID), Role: string(role)}
		d.Revision++
		return nil
	})
	if err != nil {
		return err
	}

	outDir := filepath.Join(cfg.RunRoot, "runs", runID, "out", string(nodeID))
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	obs, err := cfg.Runner.Invoke(ctx, Job{
		RunID:  runID,
		NodeID: string(nodeID),
		Role:   role,
		OutDir: outDir,
		Argv:   append([]string(nil), n.Argv...),
	})
	if err != nil {
		return err
	}

	evidenceRef := filepath.Join("out", string(nodeID), "result.json")
	if err := os.WriteFile(filepath.Join(outDir, "result.json"), obs.ResultRaw, 0o644); err != nil {
		return err
	}

	return cfg.Store.Transact(ctx, runID, func(d *Document) error {
		g, err := decodeGraph(d.Graph)
		if err != nil {
			return err
		}
		ok := observationOK(role, obs)
		checkPassed := false
		if n.Purpose == graph.PurposeCheck && ok {
			checkPassed = true
		}
		g, err = graph.Apply(g, graph.Transition{Observe: &graph.ObserveSpec{
			NodeID:      nodeID,
			Status:      graph.StatusObserved,
			OK:          ok,
			CheckPassed: checkPassed,
		}})
		if err != nil {
			return err
		}
		raw, err := encodeGraph(g)
		if err != nil {
			return err
		}
		d.Graph = GraphState{Raw: raw}
		d.Dispatching = nil
		d.Observations = append(d.Observations, ObservationRecord{
			NodeID:      string(nodeID),
			Status:      string(obs.Status),
			ExitCode:    obs.ExitCode,
			OK:          ok,
			EvidenceRef: evidenceRef,
		})
		d.Revision++
		return nil
	})
}

func observationOK(role Role, obs Observation) bool {
	if obs.Status != StatusCompleted {
		return false
	}
	if role == RoleCommand {
		return obs.ExitCode != nil && *obs.ExitCode == 0
	}
	return true
}

func consultSupervisor(ctx context.Context, cfg *config, runID string) error {
	doc, err := cfg.Store.Get(ctx, runID)
	if err != nil {
		return err
	}
	view, err := supervisor.BuildView(supervisor.Input{
		RunID:      runID,
		Generation: doc.Generation,
		Revision:   doc.Revision,
		Pinned: supervisor.Pinned{
			GraphID:     doc.Pinned.GraphID,
			Request:     doc.Pinned.Request,
			Stages:      append([]string(nil), doc.Pinned.Stages...),
			Definitions: doc.Pinned.Definitions,
		},
		GraphJSON: doc.Graph.Raw,
	})
	if err != nil {
		return err
	}
	outDir := filepath.Join(cfg.RunRoot, "runs", runID, "out", "supervisor")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}
	obs, err := cfg.Runner.Invoke(ctx, Job{
		RunID:  runID,
		Role:   RoleSupervisor,
		OutDir: outDir,
		Packet: view.Bytes,
	})
	if err != nil {
		return err
	}
	dec, err := supervisor.ParseDecision(obs.ResultRaw)
	if err != nil {
		return err
	}
	return cfg.Store.Transact(ctx, runID, func(d *Document) error {
		if dec.RunID != d.RunID {
			return fmt.Errorf("controller: decision run_id mismatch")
		}
		if dec.Generation != d.Generation {
			return fmt.Errorf("controller: decision generation mismatch")
		}
		if dec.ExpectedRevision != d.Revision {
			return fmt.Errorf("controller: decision revision mismatch")
		}
		g, err := decodeGraph(d.Graph)
		if err != nil {
			return err
		}
		switch dec.Action {
		case supervisor.ActionStop:
			d.Status = "stopped"
			d.LastDecisionID = dec.DecisionID
			d.Revision++
			return nil
		case supervisor.ActionAppend:
			nodes := make([]graph.Node, 0, len(dec.Nodes))
			for _, dn := range dec.Nodes {
				if err := validatePathComponent(dn.ID, "node id"); err != nil {
					return err
				}
				n := graph.Node{
					ID:        graph.NodeID(dn.ID),
					Stage:     graph.StageID(dn.Stage),
					Kind:      graph.Kind(dn.Kind),
					Purpose:   graph.Purpose(dn.Purpose),
					Bootstrap: dn.Bootstrap,
					Argv:      append([]string(nil), dn.Argv...),
				}
				for _, a := range dn.After {
					n.After = append(n.After, graph.NodeID(a))
				}
				for _, r := range dn.Requires {
					n.Requires = append(n.Requires, graph.ReceiptID(r))
				}
				nodes = append(nodes, n)
			}
			g, err = graph.Apply(g, graph.Transition{Append: &graph.AppendSpec{Nodes: nodes}})
			if err != nil {
				return err
			}
		case supervisor.ActionPlan:
			// Plan is recorded as a decision only in this ticket; nodes come via append.
		default:
			return fmt.Errorf("controller: unsupported supervisor action %q", dec.Action)
		}
		raw, err := encodeGraph(g)
		if err != nil {
			return err
		}
		d.Graph = GraphState{Raw: raw}
		d.LastDecisionID = dec.DecisionID
		d.Revision++
		return nil
	})
}

func markInterrupted(ctx context.Context, store Store, runID, reason string) error {
	return store.Transact(ctx, runID, func(d *Document) error {
		if d.Status != "active" {
			return nil
		}
		d.Status = "interrupted"
		d.FailureReason = reason
		d.Revision++
		return nil
	})
}

func resolveConfig(opts []Option, needRunner bool) (*config, error) {
	c := applyOptions(opts)
	if needRunner && c.Runner == nil {
		return nil, errors.New("controller: Runner required")
	}
	if c.Store == nil {
		return nil, errors.New("controller: Store required")
	}
	if needRunner && c.RunRoot == "" {
		return nil, errors.New("controller: RunRoot required")
	}
	return c, nil
}

func applyOptions(opts []Option) *config {
	c := &config{}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

func encodeGraph(s graph.State) ([]byte, error) {
	return json.Marshal(s)
}

func decodeGraph(gs GraphState) (graph.State, error) {
	if len(gs.Raw) == 0 {
		return graph.State{}, errors.New("controller: empty graph state")
	}
	var s graph.State
	if err := json.Unmarshal(gs.Raw, &s); err != nil {
		return graph.State{}, err
	}
	if s.Receipts == nil {
		s.Receipts = map[graph.StageID]graph.Receipt{}
	}
	return s, nil
}

func newRunID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "run-" + hex.EncodeToString(b[:]), nil
}

var errNotImplemented = errors.New("controller: not implemented")
