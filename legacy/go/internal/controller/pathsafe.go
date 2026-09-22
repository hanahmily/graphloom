package controller

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var pathComponentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// validatePathComponent rejects IDs that could escape a single directory entry.
func validatePathComponent(id, kind string) error {
	if id == "" || id == "." || id == ".." {
		return fmt.Errorf("controller: invalid %s %q", kind, id)
	}
	if strings.ContainsAny(id, `/\`) || filepath.Base(id) != id {
		return fmt.Errorf("controller: invalid %s %q", kind, id)
	}
	if !pathComponentPattern.MatchString(id) {
		return fmt.Errorf("controller: invalid %s %q", kind, id)
	}
	return nil
}
