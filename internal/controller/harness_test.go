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
