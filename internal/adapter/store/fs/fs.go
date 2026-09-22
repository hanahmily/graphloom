// Package fs is the durable filesystem Store adapter.
package fs

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/hanahmily/graphloom/internal/controller"
)

var runIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// Store persists run state under a host directory tree.
type Store struct {
	Root string
	mu   sync.Mutex
}

func New(root string) *Store { return &Store{Root: root} }

func (s *Store) Transact(ctx context.Context, runID string, fn func(*controller.Document) error) error {
	_ = ctx
	if err := validateRunID(runID); err != nil {
		return err
	}
	return s.withLock(runID, func() error {
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
	})
}

func (s *Store) Get(ctx context.Context, runID string) (*controller.Document, error) {
	_ = ctx
	if err := validateRunID(runID); err != nil {
		return nil, err
	}
	var doc *controller.Document
	err := s.withLock(runID, func() error {
		var err error
		doc, err = s.read(runID)
		return err
	})
	return doc, err
}

func (s *Store) EnqueueCommand(ctx context.Context, runID string, cmd controller.RunCommand) error {
	_ = ctx
	_ = runID
	_ = cmd
	return errors.New("store/fs: enqueue not implemented")
}

func (s *Store) withLock(runID string, fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir(runID), 0o755); err != nil {
		return err
	}
	lockDir := filepath.Join(s.dir(runID), ".lock")
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := os.Mkdir(lockDir, 0o700)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("store/fs: timed out waiting for run lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer os.Remove(lockDir)
	return fn()
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
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	tmp := filepath.Join(s.dir(runID), "state."+hex.EncodeToString(suffix[:])+".tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.statePath(runID))
}

func validateRunID(runID string) error {
	if runID == "" {
		return errors.New("store/fs: empty run id")
	}
	if runID == "." || runID == ".." || strings.ContainsAny(runID, `/\`) || filepath.Base(runID) != runID {
		return fmt.Errorf("store/fs: invalid run id %q", runID)
	}
	if !runIDPattern.MatchString(runID) {
		return fmt.Errorf("store/fs: invalid run id %q", runID)
	}
	return nil
}

var _ controller.Store = (*Store)(nil)
