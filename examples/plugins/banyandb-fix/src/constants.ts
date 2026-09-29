import type { EnvironmentDeclaration, ExecutorPin } from "@graphloom/sdk";

export const FIX_STAGE = "fix";
export const REVIEW_STAGE = "review";

export const REQUIREMENT_DECISIONS = "decisions-recorded";
export const REQUIREMENT_REPRODUCES = "reproduces";
export const REQUIREMENT_PASSES = "passes";
export const REQUIREMENT_BUILDS = "builds";
export const REQUIREMENT_SCOPE = "in-scope";
export const REQUIREMENT_CHANGELOG = "changelog-entry";
export const REQUIREMENT_REVIEW = "spec-and-standards-review";

/** Issues live in apache/skywalking; the code lives in the task's repository. */
export const ISSUE_REPO = { owner: "apache", repo: "skywalking" } as const;

export const CHANGES_PATH = "CHANGES.md";

/** Paths the implementer may not change unless the decision record names one with a reason. */
export const PROTECTED_PATHS = ["api/proto", "go.mod", "go.sum", ".github"] as const;

/** Plan, implement and corrections share this key, so each continues the previous session. */
export const IMPLEMENTER_JOB = "implementer";
export const IMPLEMENTER_HARNESS = "claude-code";
export const REVIEWER_HARNESS = "pi";

export const CODING_AGENT: ExecutorPin = { id: "graphloom.coding-agent/run", version: "1" };
export const GET_ISSUE: ExecutorPin = { id: "graphloom.github/get-issue", version: "1" };
export const LIST_ISSUE_COMMENTS: ExecutorPin = { id: "graphloom.github/list-issue-comments", version: "1" };

/** Corrections the graph dispatches itself in Fix before it asks the supervisor. */
export const MAX_FIX_CORRECTIONS = 2;

/** Command ids the validators read. */
export const COMMAND = {
  regression: "regression",
  testCi: "test-ci",
  license: "license-check",
  build: "build",
  lint: "lint",
  check: "check",
  changesDiff: "changes-diff",
  deliver: "deliver",
} as const;

export const BUILD_COMMANDS = [COMMAND.license, COMMAND.build, COMMAND.lint, COMMAND.check] as const;

const MINUTE = 60_000;

/**
 * BanyanDB's contributor checklist (CONTRIBUTING.md), checked by the controller
 * before any job. A changed CONTRIBUTING.md means this checklist may be stale:
 * the supervisor repairs it here and pins the new digest. Node.js is checked by
 * `make check-req` through the ui and mcp projects.
 */
export const ENVIRONMENT: EnvironmentDeclaration = {
  checks: [
    {
      id: "go",
      argv: [
        "sh",
        "-c",
        'want=$(sed -n "s/^go //p" go.mod); have=$(go env GOVERSION) || exit 127; [ "$have" = "go$want" ] || { echo "$have found; go.mod needs go$want" >&2; exit 1; }',
      ],
    },
    {
      id: "git",
      argv: [
        "sh",
        "-c",
        'v=$(git --version | sed -n "s/^git version \\([0-9]*\\)\\.\\([0-9]*\\).*/\\1 \\2/p"); set -- $v; [ "${1:-0}" -gt 2 ] || { [ "${1:-0}" -eq 2 ] && [ "${2:-0}" -ge 30 ]; } || { echo "git >= 2.30 required; found $(git --version)" >&2; exit 1; }',
      ],
    },
    { id: "make", argv: ["sh", "-c", 'make --version 2>/dev/null | grep -q "GNU Make" || { echo "GNU make required" >&2; exit 1; }'] },
    { id: "check-req", argv: ["make", "check-req"], timeoutMs: 20 * MINUTE },
  ],
  prepare: [{ id: "generate", argv: ["make", "generate"], timeoutMs: 30 * MINUTE }],
  pinnedFiles: [{ path: "CONTRIBUTING.md", sha256: "c5d43a0272accb597b1ddc502bd5ce374b233fe327e80f3420b84a4ac67f2f71" }],
};
