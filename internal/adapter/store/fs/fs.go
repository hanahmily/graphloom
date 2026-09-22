// Package fs is the durable filesystem Store adapter.
package fs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/hanahmily/graphloom/internal/controller"
)

// Store persists run state under a host directory tree.
type Store struct {
	Root string
	mu   sync.Mutex
}

func New(root string) *Store { return &Store{Root: root} }

func (s *Store) Transact(ctx context.Context, runID string, fn func(*controller.Document) error) error {
	_ = ctx
	if runID == "" {
		return errors.New("store/fs: empty run id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.read(runID)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		doc = &controller.Document{RunID: runID, Status: "active"}
	}
	if err := fn(doc); err != nil {
		return err
	}
	doc.RunID = runID
	return s.write(runID, doc)
}

func (s *Store) Get(ctx context.Context, runID string) (*controller.Document, error) {
	_ = ctx
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read(runID)
}

func (s *Store) EnqueueCommand(ctx context.Context, runID string, cmd controller.RunCommand) error {
	_ = ctx
	_ = runID
	_ = cmd
	return errors.New("store/fs: enqueue not implemented")
}

func (s *Store) dir(runID string) string {
	return filepath.Join(s.Root, "runs", runID)
}

func (s *Store) statePath(runID string) string {
	return filepath.Join(s.dir(runID), "state.json")
}

func (s *Store) read(runID string) (*controller.Document, error) {
	b, err := os.ReadFile(s.statePath(runID))
	if err != nil {
		return nil, err
	}
	var doc controller.Document
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, fmt.Errorf("store/fs: decode: %w", err)
	}
	return &doc, nil
}

func (s *Store) write(runID string, doc *controller.Document) error {
	if err := os.MkdirAll(s.dir(runID), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.statePath(runID) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.statePath(runID))
}

var _ controller.Store = (*Store)(nil)
