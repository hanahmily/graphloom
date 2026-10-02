import type { EnvironmentDeclaration, ExecutorPin } from "@graphloom/sdk";

export const FIX_STAGE = "fix";
export const REVIEW_STAGE = "review";

export const REQUIREMENT_DECISIONS = "decisions-recorded";
export const REQUIREMENT_REPRODUCES = "reproduces";
export const REQUIREMENT_PASSES = "passes";
export const REQUIREMENT_BUILDS = "builds";
export const REQUIREMENT_SCOPE = "in-scope";
export const REQUIREMENT_CHANGELOG = "changelog-entry";
export const REQUIREMENT_PLAN_REVIEW = "plan-reviewed";
export const REQUIREMENT_REVIEW = "code-review";

/** Issues live in apache/skywalking; the code lives in the task's repository. */
export const ISSUE_REPO = { owner: "apache", repo: "skywalking" } as const;

export const CHANGES_PATH = "CHANGES.md";

/** Paths the implementer may not change unless the decision record names one with a reason. */
export const PROTECTED_PATHS = ["api/proto", "go.mod", "go.sum", ".github"] as const;

/** Plan, implement and corrections share this key, so each continues the previous session. */
export const IMPLEMENTER_JOB = "implementer";
export const IMPLEMENTER_HARNESS = "claude-code";
export const REVIEWER_HARNESS = "pi";
/** Reviews the code in open-code-review's delegation mode; the harness runs it read-only. */
export const CODE_REVIEWER_HARNESS = "codex";
/** Verifies critical and high findings: another model family than the code reviewer, in a fresh read-only session. */
export const VERIFIER_HARNESS = "claude-code";

export const CODING_AGENT: ExecutorPin = { id: "graphloom.coding-agent/run", version: "1" };
export const GET_ISSUE: ExecutorPin = { id: "graphloom.github/get-issue", version: "1" };
export const LIST_ISSUE_COMMENTS: ExecutorPin = { id: "graphloom.github/list-issue-comments", version: "1" };

/** Corrections the graph dispatches itself in Fix before it asks the supervisor. */
export const MAX_FIX_CORRECTIONS = 2;
/** Rounds a single plan-review finding may go unresolved (planner answers, reviewer repeats it) before the supervisor decides that finding. */
export const MAX_FINDING_ROUNDS = 2;
/** Plan-review passes on one generation overall, as a backstop: unlike work dispatches, these are never charged against the corrections budget. */
export const MAX_PLAN_REVIEW_ROUNDS = 6;
/** Code review passes on one change in one generation; a sweep that reaches it has not saturated. */
export const MAX_SWEEP_PASSES = 4;

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
 * the supervisor repairs it here and pins the new digest. `check-req` here runs
 * only its Go version and architecture test; `make check-req` also runs
 * `ui check-version` and `mcp check-version`, which need Node.js and run
 * `npm ci`. Node.js is required unconditionally, not only for a task that
 * touches `ui/` or `mcp/`: preparation's `make generate` and the `build`
 * requirement's `make build` both loop over every project, `ui` and `mcp`
 * included, and each needs `npm ci` regardless of what the task changes
 * (confirmed with `make -n` in the target repository). Scoping either to a
 * Node-free subset would mean overriding BanyanDB's own `PROJECTS` variable
 * per target, coupled to its Makefile internals; a dedicated `node` check
 * here, cheaper than the full `ui check-version`/`mcp check-version`, is the
 * safer choice until those paths support Go-only execution. Code review needs
 * open-code-review with its delegation mode, and git 2.41 for it; the `ocr`
 * check prints the absolute path the code reviewer is told to run. Planning and
 * implementing need Claude Code, and code review needs Codex, each installed
 * and logged in, found the way its harness finds it (`GRAPHLOOM_CLAUDE_BIN`,
 * `GRAPHLOOM_CLAUDE_CONFIG_DIR`, `GRAPHLOOM_CODEX_BIN`, `GRAPHLOOM_CODEX_HOME`).
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
        'v=$(git --version | sed -n "s/^git version \\([0-9]*\\)\\.\\([0-9]*\\).*/\\1 \\2/p"); set -- $v; [ "${1:-0}" -gt 2 ] || { [ "${1:-0}" -eq 2 ] && [ "${2:-0}" -ge 41 ]; } || { echo "git >= 2.41 required; found $(git --version)" >&2; exit 1; }',
      ],
    },
    {
      id: "ocr",
      argv: [
        "sh",
        "-c",
        'p=$(command -v ocr) || { echo "open-code-review (ocr) is not installed" >&2; exit 127; }; ' +
          'case "$p" in /*) ;; *) p="$(pwd)/$p" ;; esac; ' +
          '"$p" delegate preview --help >/dev/null 2>&1 || { echo "$p has no delegation mode; install open-code-review 1.9 or later" >&2; exit 1; }; ' +
          "printf '%s\\n' \"$p\"",
      ],
      timeoutMs: 2 * MINUTE,
    },
    {
      id: "codex",
      argv: [
        "sh",
        "-c",
        'c="${GRAPHLOOM_CODEX_BIN:-codex}"; h="${GRAPHLOOM_CODEX_HOME:-${CODEX_HOME:-}}"; [ -z "$h" ] || export CODEX_HOME="$h"; ' +
          '"$c" --version >/dev/null 2>&1 || { echo "Codex ($c) is not installed" >&2; exit 127; }; ' +
          '"$c" login status >/dev/null 2>&1 || { echo "Codex is not logged in${h:+ for $h}: run $c login" >&2; exit 1; }',
      ],
      timeoutMs: 2 * MINUTE,
    },
    {
      id: "claude",
      argv: [
        "sh",
        "-c",
        'c="${GRAPHLOOM_CLAUDE_BIN:-claude}"; d="${GRAPHLOOM_CLAUDE_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-}}"; [ -z "$d" ] || export CLAUDE_CONFIG_DIR="$d"; ' +
          '"$c" --version >/dev/null 2>&1 || { echo "Claude Code ($c) is not installed" >&2; exit 127; }; ' +
          '"$c" auth status >/dev/null 2>&1 || { echo "Claude Code is not logged in${d:+ for $d}: run $c auth login" >&2; exit 1; }',
      ],
      timeoutMs: 2 * MINUTE,
    },
    { id: "make", argv: ["sh", "-c", 'make --version 2>/dev/null | grep -q "GNU Make" || { echo "GNU make required" >&2; exit 1; }'] },
    { id: "check-req", argv: ["make", "-C", "scripts/ci/check", "test"], timeoutMs: 5 * MINUTE },
    {
      id: "node",
      argv: [
        "sh",
        "-c",
        'v=$(node --version 2>/dev/null) || { echo "Node.js >= 24.6.0 is required (make generate and make build run npm ci for the ui and mcp projects, on every task)" >&2; exit 127; }; ' +
          'n=$(echo "$v" | sed -n "s/^v\\([0-9]*\\)\\.\\([0-9]*\\).*/\\1 \\2/p"); set -- $n; maj=${1:-0}; min=${2:-0}; ' +
          '{ [ "$maj" -gt 24 ] || { [ "$maj" -eq 24 ] && [ "$min" -ge 6 ]; }; } || { echo "Node.js >= 24.6.0 required, found $v" >&2; exit 1; }',
      ],
      timeoutMs: 2 * MINUTE,
    },
  ],
  prepare: [{ id: "generate", argv: ["make", "generate"], timeoutMs: 30 * MINUTE }],
  pinnedFiles: [{ path: "CONTRIBUTING.md", sha256: "c5d43a0272accb597b1ddc502bd5ce374b233fe327e80f3420b84a4ac67f2f71" }],
};
