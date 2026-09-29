/**
 * What a `go test -json` report says about one top-level test:
 * - `failed`: the test ran and failed (an assertion, not a build error or a panic);
 * - `panicked`: the test ran and panicked, so it proves nothing about the behaviour it asserts;
 * - `passed`: the test ran and passed;
 * - `build-failed`: the package did not build, so the test never ran;
 * - `not-run`: the report has no result for the test.
 */
export type TestOutcome = "failed" | "panicked" | "passed" | "build-failed" | "not-run";

interface TestEvent {
  Action?: string;
  Test?: string;
  Package?: string;
  ImportPath?: string;
  Output?: string;
}

export function testOutcome(report: string, testName: string): TestOutcome {
  let outcome: TestOutcome = "not-run";
  let buildFailed = false;
  let panicked = false;
  for (const line of report.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      if (/\[(build|setup) failed\]/.test(trimmed)) buildFailed = true;
      continue;
    }
    let event: TestEvent;
    try {
      event = JSON.parse(trimmed) as TestEvent;
    } catch {
      continue;
    }
    if (event.Action === "build-fail") buildFailed = true;
    if (event.Action === "output" && event.Test === undefined && /\[(build|setup) failed\]/.test(event.Output ?? "")) buildFailed = true;
    if (event.Test !== testName) continue;
    if (event.Action === "output" && /^panic: /m.test(event.Output ?? "")) panicked = true;
    if (event.Action === "fail") outcome = "failed";
    else if (event.Action === "pass" && outcome !== "failed") outcome = "passed";
  }
  if (buildFailed && outcome !== "failed") return "build-failed";
  return outcome === "failed" && panicked ? "panicked" : outcome;
}

/**
 * The package's own messages in a report, such as a flag or compile error,
 * without logger lines, the test binary's usage text or per-test output.
 */
export function packageOutput(report: string): string {
  const lines: string[] = [];
  for (const line of report.split("\n")) {
    let event: TestEvent;
    try {
      event = JSON.parse(line) as TestEvent;
    } catch {
      continue;
    }
    if (event.Action !== "output" || event.Test !== undefined) continue;
    for (const text of (event.Output ?? "").split("\n")) {
      if (text.trim() === "" || /^\s/.test(text) || /^(\{|Usage of |FAIL|ok |PASS|exit status |=== |--- )/.test(text)) continue;
      lines.push(text);
    }
  }
  return lines.join("\n");
}

/** One Ginkgo spec that ran, as the regression command reports it. */
export interface GinkgoSpec {
  /** Container texts and the leaf text, joined by spaces. */
  text: string;
  /** The leaf node type: `It`, or a suite node such as `BeforeSuite`. */
  node: string;
  /** `passed`, `failed`, `panicked`, `interrupted`, `aborted` or `timedout`. */
  state: string;
  /** Where a failure happened: `It` for the spec body, or a setup node such as `BeforeEach`. */
  failureNode: string;
  message: string;
}

/** What a regression run says about the named test: `setup-failed` is a Ginkgo spec that failed outside its own body. */
export type RegressionOutcome = TestOutcome | "setup-failed";

const GINKGO_MARKER = "GraphLoomGinkgo";

/**
 * The Ginkgo specs a regression run executed, or undefined when the run did not
 * use Ginkgo. An empty list means the suite ran no spec or its report was lost.
 */
export function ginkgoSpecs(report: string): GinkgoSpec[] | undefined {
  let specs: GinkgoSpec[] | undefined;
  for (const line of report.split("\n")) {
    if (!line.startsWith(`{"${GINKGO_MARKER}"`)) continue;
    try {
      const parsed = (JSON.parse(line) as Record<string, { specs?: GinkgoSpec[] }>)[GINKGO_MARKER];
      specs = Array.isArray(parsed?.specs) ? parsed.specs : [];
    } catch {
      specs = [];
    }
  }
  return specs;
}

/**
 * The outcome of the regression test: from the Ginkgo specs that ran when the
 * package uses Ginkgo, else from `go test -json`.
 */
export function regressionOutcome(report: string, test: { name: string; focus?: string }): RegressionOutcome {
  const specs = ginkgoSpecs(report);
  if (specs === undefined) return testOutcome(report, test.name);
  const its = specs.filter((s) => s.node === "It");
  const broken = (s: GinkgoSpec) => s.state !== "passed";
  if (its.some((s) => s.state === "panicked" && s.failureNode === "It")) return "panicked";
  if (its.some((s) => s.state === "failed" && s.failureNode === "It")) return "failed";
  if (its.some(broken)) return "setup-failed";
  if (its.length > 0 && !specs.some(broken)) return "passed";
  return testOutcome(report, test.name) === "build-failed" ? "build-failed" : "not-run";
}

/** Reduces a Ginkgo JSON report to one line naming the specs that ran; the full report lists every skipped spec too. */
const GINKGO_FILTER = `package main

import (
	"encoding/json"
	"os"
	"strings"
)

type spec struct {
	Text        string \`json:"text"\`
	Node        string \`json:"node"\`
	State       string \`json:"state"\`
	FailureNode string \`json:"failureNode"\`
	Message     string \`json:"message"\`
}

func main() {
	out := map[string]any{}
	defer func() { json.NewEncoder(os.Stdout).Encode(map[string]any{"${GINKGO_MARKER}": out}) }()
	b, err := os.ReadFile(os.Args[1])
	if err != nil {
		out["missing"] = true
		return
	}
	var suites []struct {
		SpecReports []struct {
			ContainerHierarchyTexts []string
			LeafNodeType, LeafNodeText, State string
			Failure struct{ Message, FailureNodeType string }
		}
	}
	if json.Unmarshal(b, &suites) != nil {
		out["unreadable"] = true
		return
	}
	specs := []spec{}
	for _, s := range suites {
		for _, r := range s.SpecReports {
			if r.State == "skipped" || r.State == "pending" {
				continue
			}
			m := r.Failure.Message
			if len(m) > 400 {
				m = m[:400]
			}
			text := strings.TrimSpace(strings.Join(append(r.ContainerHierarchyTexts, r.LeafNodeText), " "))
			specs = append(specs, spec{text, r.LeafNodeType, r.State, r.Failure.FailureNodeType, m})
		}
	}
	out["specs"] = specs
}
`;

/**
 * The argv that runs exactly the regression test and writes its JSON report.
 * The focus reaches only a package whose tests use Ginkgo; a plain test binary
 * rejects the flag before running anything. For Ginkgo, the report also gets
 * one line naming the specs that ran, so the suite's TestXxx result alone
 * cannot stand for the spec.
 */
export function regressionArgv(test: { package: string; name: string; focus?: string }): string[] {
  const go = 'go test -json -count=1 -run "$2" "$3"';
  const ginkgo = [
    'r="$GRAPHLOOM_REPORT_FILE"',
    `${go} -args "-ginkgo.focus=$1" "-ginkgo.json-report=$r.ginkgo" > "$r"`,
    "rc=$?",
    'd="$(mktemp -d)"',
    `printf '%s' "$4" > "$d/main.go"`,
    `(cd "$d" && GOFLAGS= GOWORK=off go run main.go "$r.ginkgo") >> "$r" || echo '{"${GINKGO_MARKER}":{"unreadable":true}}' >> "$r"`,
    'rm -rf "$d"',
    "exit $rc",
  ].join("; ");
  return [
    "sh",
    "-c",
    `if [ -n "$1" ] && grep -qs "github.com/onsi/ginkgo" "$3"/*_test.go; then ${ginkgo}; else exec ${go} > "$GRAPHLOOM_REPORT_FILE"; fi`,
    "regression",
    test.focus ?? "",
    `^${test.name}$`,
    test.package,
    GINKGO_FILTER,
  ];
}
