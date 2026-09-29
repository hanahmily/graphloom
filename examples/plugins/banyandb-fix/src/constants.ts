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

export const CODING_AGENT: ExecutorPin = { id: "graphloom.coding-agent/run", version: "1" };
export const GET_ISSUE: ExecutorPin = { id: "graphloom.github/get-issue", version: "1" };
export const LIST_ISSUE_COMMENTS: ExecutorPin = { id: "graphloom.github/list-issue-comments", version: "1" };

/** Corrections the graph dispatches itself in Fix before it asks the supervisor. */
export const MAX_FIX_CORRECTIONS = 2;
/** Plans the reviewer may send back in one generation before the supervisor decides. */
export const MAX_PLAN_REVISIONS = 2;

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
 * `make check-req` through the ui and mcp projects. Code review needs
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
    { id: "check-req", argv: ["make", "check-req"], timeoutMs: 20 * MINUTE },
  ],
  prepare: [{ id: "generate", argv: ["make", "generate"], timeoutMs: 30 * MINUTE }],
  pinnedFiles: [{ path: "CONTRIBUTING.md", sha256: "c5d43a0272accb597b1ddc502bd5ce374b233fe327e80f3420b84a4ac67f2f71" }],
};
