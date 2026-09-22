package controller

import (
	"context"
	"time"
)

// Runner launches supervisor turns, agents, and command nodes.
// Serial jobs only in the MVP: at most one in-flight Invoke per run.
type Runner interface {
	Invoke(ctx context.Context, job Job) (Observation, error)
}

type Role string

const (
	RoleSupervisor Role = "supervisor"
	RoleWorker     Role = "worker"
	RoleReviewer   Role = "reviewer"
	RoleCommand    Role = "command"
)

type Job struct {
	RunID    string
	NodeID   string // empty for a supervisor turn
	Role     Role
	Worktree string
	OutDir   string
	Scope    Scope
	Bounds   Bounds
	Packet   []byte
	Argv     []string // command nodes only; no shell
}

type Scope struct {
	ReadRoots  []string
	WriteRoots []string
}

type Bounds struct {
	Deadline time.Time
}

type Status string

const (
	StatusCompleted   Status = "completed"
	StatusBlocked     Status = "blocked"
	StatusFailed      Status = "failed"
	StatusInterrupted Status = "interrupted"
)

type Observation struct {
	Status    Status
	ExitCode  *int
	ResultRaw []byte
}
