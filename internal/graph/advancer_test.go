package graph_test

import (
	"errors"
	"testing"

	"github.com/hanahmily/graphloom/internal/graph"
)

func TestEmptyActiveRunIsBlockedNotComplete(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	info := graph.Ready(s)
	if info.Complete || !info.Blocked || info.ReadyNode != nil {
		t.Fatalf("Ready = %+v, want blocked with no ready node", info)
	}
	if graph.Complete(s) {
		t.Fatal("Complete = true, want false")
	}
}

func TestAppendObserveMakesNodeReady(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s, err := graph.Apply(s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{
			ID:        "plan-1",
			Purpose:   graph.PurposeReview,
			Kind:      graph.KindAgent,
			Bootstrap: true,
		}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	info := graph.Ready(s)
	if info.ReadyNode == nil || *info.ReadyNode != "plan-1" {
		t.Fatalf("Ready = %+v, want plan-1", info)
	}

	s, err = graph.Apply(s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "plan-1",
		Status: graph.StatusObserved,
		OK:     true,
	}})
	if err != nil {
		t.Fatal(err)
	}
	info = graph.Ready(s)
	if !info.Blocked || info.ReadyNode != nil {
		t.Fatalf("after observe Ready = %+v, want blocked", info)
	}
}

func TestHappyPathAcceptWriteThenReview(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())

	// Observe plan review, write, check.
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})

	s, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage:            "write",
		ReceiptID:        "rcpt-write-1",
		Fingerprint:      "ws:1",
		PlanReviewNodeID: "plan-1",
		CheckNodeID:      "check-1",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if graph.Complete(s) {
		t.Fatal("complete after write only")
	}

	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "review-1", Status: graph.StatusObserved, OK: true,
		Fingerprint: "ws:1", ReviewApproved: true,
	}})
	s, err = graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage:            "review",
		ReceiptID:        "rcpt-review-1",
		Fingerprint:      "ws:1",
		PlanReviewNodeID: "plan-1",
		CheckNodeID:      "check-1",
		ReviewNodeID:     "review-1",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !graph.Complete(s) {
		t.Fatal("want complete after both receipts")
	}
	info := graph.Ready(s)
	if !info.Complete || info.Blocked || info.ReadyNode != nil {
		t.Fatalf("Ready = %+v, want complete", info)
	}
}

func TestRejectAcceptWithoutPassingCheck(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: false}})

	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestRejectSkipWriteToAcceptReview(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})

	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "review", ReceiptID: "rcpt-review-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1", ReviewNodeID: "review-1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject for skipped write", err)
	}
}

func TestRejectStaleFingerprintOnAccept(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})

	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:2",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject for stale fingerprint", err)
	}
}

func TestReenterInvalidatesLaterReceiptsAndCancelsDependents(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})
	s = mustApply(t, s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "review-1", Status: graph.StatusObserved, OK: true,
		Fingerprint: "ws:1", ReviewApproved: true,
	}})
	s = mustApply(t, s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "review", ReceiptID: "rcpt-review-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1", ReviewNodeID: "review-1",
	}})
	if !graph.Complete(s) {
		t.Fatal("setup: want complete before reenter")
	}

	// Append a pending follow-up that requires the write receipt.
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{
			ID:       "rewrite-pending",
			Stage:    "write",
			Kind:     graph.KindAgent,
			Purpose:  graph.PurposeWork,
			Requires: []graph.ReceiptID{"rcpt-write-1"},
		}},
	}})

	s, err := graph.Apply(s, graph.Transition{Reenter: &graph.ReenterSpec{Stage: "write"}})
	if err != nil {
		t.Fatal(err)
	}
	if graph.Complete(s) {
		t.Fatal("complete after reenter")
	}
	if s.Receipt("write") != nil && s.Receipt("write").Valid {
		t.Fatal("write receipt still valid")
	}
	if s.Receipt("review") != nil && s.Receipt("review").Valid {
		t.Fatal("review receipt still valid")
	}
	// Historical receipts remain inspectable.
	if len(s.ReceiptHistory) < 2 {
		t.Fatalf("ReceiptHistory = %d, want retained history", len(s.ReceiptHistory))
	}
	n := s.Node("rewrite-pending")
	if n == nil || n.Status != graph.StatusCancelled {
		t.Fatalf("dependent node = %+v, want cancelled", n)
	}
}

func TestAppendOnlyRejectsDuplicateNodeID(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{ID: "write-1", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork}},
	}})
	_, err := graph.Apply(s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{ID: "write-1", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork}},
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestReadyWaitsForAfterDependencyEvenIfFailed(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{
			{ID: "check-1", Stage: "write", Kind: graph.KindCommand, Purpose: graph.PurposeCheck},
			{ID: "diag-1", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork, After: []graph.NodeID{"check-1"}},
		},
	}})
	info := graph.Ready(s)
	if info.ReadyNode == nil || *info.ReadyNode != "check-1" {
		t.Fatalf("Ready = %+v, want check-1 first", info)
	}
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "check-1", Status: graph.StatusObserved, OK: false, CheckPassed: false, Fingerprint: "ws:1",
	}})
	info = graph.Ready(s)
	if info.ReadyNode == nil || *info.ReadyNode != "diag-1" {
		t.Fatalf("Ready = %+v, want diag-1 after failed check observation", info)
	}
}

func TestRejectUnknownAfterReference(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	_, err := graph.Apply(s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{
			ID: "x", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork,
			After: []graph.NodeID{"missing"},
		}},
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestRejectReviewAcceptWithoutApproval(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})
	s = mustApply(t, s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "review-1", Status: graph.StatusObserved, OK: true,
		Fingerprint: "ws:1", ReviewApproved: false,
	}})
	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "review", ReceiptID: "rcpt-review-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1", ReviewNodeID: "review-1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestRejectReobserveObservedNode(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{ID: "plan-1", Kind: graph.KindAgent, Purpose: graph.PurposeReview, Bootstrap: true}},
	}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	_, err := graph.Apply(s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: false}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestStagesRemainUnchangedAcrossApplies(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	if got := []graph.StageID(s.Stages); len(got) != 2 || got[0] != "write" || got[1] != "review" {
		t.Fatalf("Stages = %v", s.Stages)
	}
}

func TestReadySelectsReviewAfterWriteAccept(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})
	s = mustApply(t, s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	info := graph.Ready(s)
	if info.ReadyNode == nil || *info.ReadyNode != "review-1" {
		t.Fatalf("Ready = %+v, want review-1", info)
	}
}

func TestReadyBlockedWhileAnotherNodeRunning(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{
			{ID: "a", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork},
			{ID: "b", Stage: "write", Kind: graph.KindCommand, Purpose: graph.PurposeCheck, After: []graph.NodeID{"a"}},
		},
	}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "a", Status: graph.StatusRunning}})
	info := graph.Ready(s)
	if !info.Blocked || info.ReadyNode != nil {
		t.Fatalf("Ready = %+v, want blocked while running", info)
	}
}

func TestRejectBootstrapWithStage(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	_, err := graph.Apply(s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{
			ID: "bad", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeReview, Bootstrap: true,
		}},
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestRejectObserveOfNonReadyPendingNode(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{
			{ID: "a", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork},
			{ID: "b", Stage: "write", Kind: graph.KindCommand, Purpose: graph.PurposeCheck, After: []graph.NodeID{"a"}},
		},
	}})
	_, err := graph.Apply(s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "b", Status: graph.StatusObserved, OK: true, CheckPassed: true, Fingerprint: "ws:1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
	// Cancellation of a non-ready pending node remains allowed.
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "b", Status: graph.StatusCancelled}})
	if s.Node("b").Status != graph.StatusCancelled {
		t.Fatal("want cancelled")
	}
}

func TestRejectAcceptWithWrongEvidenceRoles(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{
			{ID: "plan-1", Kind: graph.KindAgent, Purpose: graph.PurposeReview, Bootstrap: true},
			{ID: "write-1", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork, After: []graph.NodeID{"plan-1"}},
		},
	}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "write-1", // work node cited as check
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestRejectAcceptWhenCheckOKFalseDespitePassedFlag(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "check-1", Status: graph.StatusObserved, OK: false, Fingerprint: "ws:1", CheckPassed: true,
	}})
	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestRejectReuseEvidenceAfterReenter(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})
	s = mustApply(t, s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	s = mustApply(t, s, graph.Transition{Reenter: &graph.ReenterSpec{Stage: "write"}})
	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-2", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject for prior-epoch check", err)
	}
}

func TestRejectDuplicateReceiptID(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, appendPlanWriteCheckReview())
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "plan-1", Status: graph.StatusObserved, OK: true}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "write-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1"}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{NodeID: "check-1", Status: graph.StatusObserved, OK: true, Fingerprint: "ws:1", CheckPassed: true}})
	s = mustApply(t, s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "write", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1",
	}})
	s = mustApply(t, s, graph.Transition{Observe: &graph.ObserveSpec{
		NodeID: "review-1", Status: graph.StatusObserved, OK: true,
		Fingerprint: "ws:1", ReviewApproved: true,
	}})
	_, err := graph.Apply(s, graph.Transition{Accept: &graph.AcceptSpec{
		Stage: "review", ReceiptID: "rcpt-write-1", Fingerprint: "ws:1",
		PlanReviewNodeID: "plan-1", CheckNodeID: "check-1", ReviewNodeID: "review-1",
	}})
	if !errors.Is(err, graph.ErrReject) {
		t.Fatalf("err = %v, want ErrReject", err)
	}
}

func TestNodeReturnsDeepCopy(t *testing.T) {
	s := graph.New(graph.Stages{"write", "review"})
	s = mustApply(t, s, graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{{
			ID: "a", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork,
			After: []graph.NodeID{}, Requires: []graph.ReceiptID{"x"},
		}},
	}})
	n := s.Node("a")
	n.Requires[0] = "mutated"
	n2 := s.Node("a")
	if n2.Requires[0] != "x" {
		t.Fatalf("Requires aliased: %v", n2.Requires)
	}
}

func appendPlanWriteCheckReview() graph.Transition {
	return graph.Transition{Append: &graph.AppendSpec{
		Nodes: []graph.Node{
			{ID: "plan-1", Kind: graph.KindAgent, Purpose: graph.PurposeReview, Bootstrap: true},
			{ID: "write-1", Stage: "write", Kind: graph.KindAgent, Purpose: graph.PurposeWork, After: []graph.NodeID{"plan-1"}},
			{ID: "check-1", Stage: "write", Kind: graph.KindCommand, Purpose: graph.PurposeCheck, After: []graph.NodeID{"write-1"}},
			{ID: "review-1", Stage: "review", Kind: graph.KindAgent, Purpose: graph.PurposeReview, After: []graph.NodeID{"check-1"}, Requires: []graph.ReceiptID{"rcpt-write-1"}},
		},
	}}
}

func mustApply(t *testing.T, s graph.State, tr graph.Transition) graph.State {
	t.Helper()
	out, err := graph.Apply(s, tr)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
