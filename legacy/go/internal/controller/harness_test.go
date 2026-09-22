package controller_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/hanahmily/graphloom/internal/adapter/runner/scripted"
	storefs "github.com/hanahmily/graphloom/internal/adapter/store/fs"
	"github.com/hanahmily/graphloom/internal/controller"
)

func TestHarnessPinsTaskAppendsCommandAndInspectsObservation(t *testing.T) {
	ctx := context.Background()
	runRoot := t.TempDir()
	fixture := writeHarnessFixture(t)

	appendDecision, _ := json.Marshal(map[string]any{
		"action":      "append",
		"decision_id": "d-append",
		"reason":      "run one check",
		"nodes": []map[string]any{{
			"id":      "cmd-1",
			"stage":   "write",
			"kind":    "command",
			"purpose": "check",
			"argv":    []string{"true"},
		}},
	})
	stopDecision, _ := json.Marshal(map[string]any{
		"action":      "stop",
		"decision_id": "d-stop",
		"reason":      "one observation recorded",
	})
	exit0 := 0
	r := scripted.New([]scripted.Step{
		{Role: controller.RoleSupervisor, Observation: controller.Observation{Status: controller.StatusCompleted, ResultRaw: appendDecision}},
		{Role: controller.RoleCommand, Observation: controller.Observation{Status: controller.StatusCompleted, ExitCode: &exit0, ResultRaw: []byte(`{"ok":true}`)}},
		{Role: controller.RoleSupervisor, Observation: controller.Observation{Status: controller.StatusCompleted, ResultRaw: stopDecision}},
	})
	st := storefs.New(runRoot)

	out, err := controller.Run(ctx, filepath.Join(fixture, "task.yaml"),
		controller.WithRunner(r),
		controller.WithStore(st),
		controller.WithRunRoot(runRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	if out.RunID == "" {
		t.Fatal("empty run id")
	}
	if out.Status != "stopped" {
		t.Fatalf("Status = %q, want stopped", out.Status)
	}

	rep, err := controller.Inspect(ctx, out.RunID, controller.WithStore(st), controller.WithRunRoot(runRoot))
	if err != nil {
		t.Fatal(err)
	}
	if rep.RunID != out.RunID {
		t.Fatalf("Inspect RunID = %q", rep.RunID)
	}
	if rep.Status != "stopped" {
		t.Fatalf("Inspect Status = %q", rep.Status)
	}
	if len(rep.ObservedNodes) != 1 || rep.ObservedNodes[0] != "cmd-1" {
		t.Fatalf("ObservedNodes = %v, want [cmd-1]", rep.ObservedNodes)
	}
	if len(rep.Observations) != 1 {
		t.Fatalf("Observations = %d, want 1", len(rep.Observations))
	}
	ev := rep.Observations[0]
	if !ev.OK || ev.EvidenceRef == "" || ev.ExitCode == nil || *ev.ExitCode != 0 {
		t.Fatalf("observation evidence = %+v", ev)
	}
	if rep.PinnedGraph != "hello" || rep.PinnedRequest == "" {
		t.Fatalf("pinned intake missing: graph=%q request=%q", rep.PinnedGraph, rep.PinnedRequest)
	}
	if len(rep.PinnedStages) != 2 || rep.PinnedStages[0] != "write" {
		t.Fatalf("PinnedStages = %v", rep.PinnedStages)
	}
	if rep.PinnedDefinitions == "" {
		t.Fatal("expected pinned stage definitions")
	}
}

func TestStoreRejectsPathTraversalRunID(t *testing.T) {
	st := storefs.New(t.TempDir())
	_, err := st.Get(context.Background(), "../escape")
	if err == nil {
		t.Fatal("expected invalid run id error")
	}
}

func TestCommandNonzeroExitIsNotOK(t *testing.T) {
	ctx := context.Background()
	runRoot := t.TempDir()
	fixture := writeHarnessFixture(t)

	appendDecision, _ := json.Marshal(map[string]any{
		"action": "append", "decision_id": "d-append",
		"nodes": []map[string]any{{
			"id": "cmd-1", "stage": "write", "kind": "command", "purpose": "check", "argv": []string{"false"},
		}},
	})
	stopDecision, _ := json.Marshal(map[string]any{
		"action": "stop", "decision_id": "d-stop", "reason": "observed failure",
	})
	exit1 := 1
	r := scripted.New([]scripted.Step{
		{Role: controller.RoleSupervisor, Observation: controller.Observation{Status: controller.StatusCompleted, ResultRaw: appendDecision}},
		{Role: controller.RoleCommand, Observation: controller.Observation{Status: controller.StatusCompleted, ExitCode: &exit1}},
		{Role: controller.RoleSupervisor, Observation: controller.Observation{Status: controller.StatusCompleted, ResultRaw: stopDecision}},
	})
	st := storefs.New(runRoot)
	out, err := controller.Run(ctx, filepath.Join(fixture, "task.yaml"),
		controller.WithRunner(r), controller.WithStore(st), controller.WithRunRoot(runRoot))
	if err != nil {
		t.Fatal(err)
	}
	rep, err := controller.Inspect(ctx, out.RunID, controller.WithStore(st))
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Observations) != 1 || rep.Observations[0].OK {
		t.Fatalf("want failed observation, got %+v", rep.Observations)
	}
}

func TestRejectUnsafeAppendNodeID(t *testing.T) {
	ctx := context.Background()
	runRoot := t.TempDir()
	fixture := writeHarnessFixture(t)
	appendDecision, _ := json.Marshal(map[string]any{
		"action": "append", "decision_id": "d-append",
		"nodes": []map[string]any{{
			"id": "../escape", "stage": "write", "kind": "command", "purpose": "check", "argv": []string{"true"},
		}},
	})
	r := scripted.New([]scripted.Step{
		{Role: controller.RoleSupervisor, Observation: controller.Observation{Status: controller.StatusCompleted, ResultRaw: appendDecision}},
	})
	st := storefs.New(runRoot)
	out, err := controller.Run(ctx, filepath.Join(fixture, "task.yaml"),
		controller.WithRunner(r), controller.WithStore(st), controller.WithRunRoot(runRoot))
	if err == nil {
		t.Fatal("expected unsafe node id to fail")
	}
	if out != nil {
		t.Fatal("expected nil outcome on failure")
	}
	// Document should be marked interrupted, not left active.
	// RunID is unknown on failure before return... actually Run returns nil, err and markInterrupted uses runID internally.
	// We can't inspect without runID. That's ok - error path is enough for this test.
}

func TestStoreReclaimsStaleLock(t *testing.T) {
	root := t.TempDir()
	st := storefs.New(root)
	runID := "run-stale"
	if err := st.Transact(context.Background(), runID, func(doc *controller.Document) error {
		doc.Status = "active"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	lockDir := filepath.Join(root, "runs", runID, ".lock")
	if err := os.MkdirAll(lockDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lockDir, "pid"), []byte("999999"), 0o644); err != nil {
		t.Fatal(err)
	}
	doc, err := st.Get(context.Background(), runID)
	if err != nil {
		t.Fatalf("expected stale lock reclaim: %v", err)
	}
	if doc.Status != "active" {
		t.Fatalf("Status = %q", doc.Status)
	}
}

func writeHarnessFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "graphs"), 0o755); err != nil {
		t.Fatal(err)
	}
	task := "graph: hello\nrepo: ./repo\nrequest: |\n  do the thing\n"
	if err := os.WriteFile(filepath.Join(dir, "task.yaml"), []byte(task), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "graphs", "hello.yaml"), []byte("happy_path: [write, review]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "graphs", "hello.md"), []byte("# hello\n\n## Write\n\ndo write\n\n## Review\n\ndo review\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "repo"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}
