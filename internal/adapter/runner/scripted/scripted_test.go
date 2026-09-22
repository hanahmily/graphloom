package scripted_test

import (
	"testing"

	"github.com/hanahmily/graphloom/internal/adapter/runner/scripted"
	"github.com/hanahmily/graphloom/internal/controller"
)

func TestInjectFenceRejectsNullDecision(t *testing.T) {
	r := scripted.New([]scripted.Step{{
		Role: controller.RoleSupervisor,
		Observation: controller.Observation{
			Status:    controller.StatusCompleted,
			ResultRaw: []byte("null"),
		},
	}})
	_, err := r.Invoke(t.Context(), controller.Job{
		Role:   controller.RoleSupervisor,
		Packet: []byte(`{"run_id":"run-1","generation":1,"revision":1}`),
	})
	if err == nil {
		t.Fatal("expected error for null decision")
	}
}
