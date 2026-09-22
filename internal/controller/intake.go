package controller

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var graphIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

type taskFile struct {
	Graph   string `yaml:"graph"`
	Repo    string `yaml:"repo"`
	Request string `yaml:"request"`
}

type graphFile struct {
	HappyPath []string `yaml:"happy_path"`
}

// loadPinnedIntake resolves task.yaml and its graph definition beside it.
func loadPinnedIntake(taskPath string) (PinnedIntake, error) {
	absTask, err := filepath.Abs(taskPath)
	if err != nil {
		return PinnedIntake{}, err
	}
	raw, err := os.ReadFile(absTask)
	if err != nil {
		return PinnedIntake{}, err
	}
	var tf taskFile
	if err := yaml.Unmarshal(raw, &tf); err != nil {
		return PinnedIntake{}, fmt.Errorf("task.yaml: %w", err)
	}
	if tf.Graph == "" || tf.Repo == "" || strings.TrimSpace(tf.Request) == "" {
		return PinnedIntake{}, fmt.Errorf("task.yaml: graph, repo, and request are required")
	}
	if !graphIDPattern.MatchString(tf.Graph) {
		return PinnedIntake{}, fmt.Errorf("task.yaml: invalid graph id %q", tf.Graph)
	}
	taskDir := filepath.Dir(absTask)
	graphYAMLPath := filepath.Join(taskDir, "graphs", tf.Graph+".yaml")
	graphMDPath := filepath.Join(taskDir, "graphs", tf.Graph+".md")
	gy, err := os.ReadFile(graphYAMLPath)
	if err != nil {
		return PinnedIntake{}, err
	}
	var gf graphFile
	if err := yaml.Unmarshal(gy, &gf); err != nil {
		return PinnedIntake{}, fmt.Errorf("graph yaml: %w", err)
	}
	if len(gf.HappyPath) == 0 {
		return PinnedIntake{}, fmt.Errorf("graph yaml: happy_path required")
	}
	defs, err := os.ReadFile(graphMDPath)
	if err != nil {
		return PinnedIntake{}, err
	}
	repoPath := tf.Repo
	if !filepath.IsAbs(repoPath) {
		repoPath = filepath.Join(taskDir, repoPath)
	}
	repoPath, err = filepath.Abs(repoPath)
	if err != nil {
		return PinnedIntake{}, err
	}
	return PinnedIntake{
		GraphID:     tf.Graph,
		RepoPath:    repoPath,
		Request:     tf.Request,
		Stages:      append([]string(nil), gf.HappyPath...),
		Definitions: string(defs),
		TaskDir:     taskDir,
	}, nil
}
