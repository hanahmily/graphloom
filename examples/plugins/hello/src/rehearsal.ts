/**
 * Hello's rehearsal scenario (docs/design-graph-rehearsal.md §4.4/§4.5):
 * recorded verbatim with `graphloom rehearse --record-from` from a real,
 * successful live run (Claude Code wrote, Claude Code reviewed), not
 * hand-written — the real model's own replies are the most realistic
 * stand-in data available, and CI rehearses on exactly this, never a
 * hand-authored guess at what a model would say.
 */
import type { GraphRehearsal } from "@graphloom/sdk";
import { GREETING_BYTES, GREETING_PATH, REVIEW_STAGE, WRITE_STAGE } from "./constants.js";

export const rehearsal: GraphRehearsal = {
  scenarios: {
    happy: {
      results: {
        "writer-result-v1": [
          {
            output: {
              status: "success",
              file_created: GREETING_PATH,
              content: GREETING_BYTES,
              bytes_verified: true,
              other_files_modified: false,
            },
            // writer-result-v1 is deliberately unconstrained ({type: "object"},
            // no declared properties, graph.ts): the assignment has nothing to
            // name, since the contract places no requirement on what shape a
            // model reports. Every field here is the real model's own free
            // choice, not something the prompt was ever obligated to ask for.
            harnessSupplied: ["status", "file_created", "content", "bytes_verified", "other_files_modified"],
            effects: [{ path: GREETING_PATH, bytes: GREETING_BYTES }],
          },
        ],
        "review-verdict-v1": [
          {
            output: {
              verdict: "approved",
              summary:
                'GREETING.txt contains exactly "Hello, GraphLoom!" followed by a single trailing newline (confirmed via Read tool: line 1 is the exact text, line 2 is the empty artifact of the one trailing \\n when splitting content on newline — no second blank line present). Git status snapshot shows only GREETING.txt as untracked/new; no other files were modified.',
              findings: [
                {
                  axis: "content-match",
                  detail: "File content matches \"Hello, GraphLoom!\\n\" exactly, no extra whitespace or extra trailing newline.",
                  severity: "none",
                },
                {
                  axis: "scope",
                  detail: "No other files were changed per git status (only GREETING.txt untracked).",
                  severity: "none",
                },
              ],
            },
            // `findings` is optional in REVIEW_SCHEMA; the real reviewer
            // volunteered it as elaboration beyond what the prompt (which
            // asks only for a verdict and a summary) requested.
            harnessSupplied: ["findings"],
          },
        ],
      },
      expect: { status: "succeeded", receipts: [WRITE_STAGE, REVIEW_STAGE] },
    },
  },
};
