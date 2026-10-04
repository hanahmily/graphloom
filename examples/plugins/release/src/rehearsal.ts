/**
 * Release's rehearsal scenario (docs/design-graph-rehearsal.md §4.4/§4.5):
 * recorded verbatim with `graphloom rehearse --record-from` from a real,
 * successful live run (Claude Code bumped the version and wrote the
 * changelog entry, then reviewed its own work), not hand-written — the real
 * model's own replies are the most realistic stand-in data available, and CI
 * rehearses on exactly this, never a hand-authored guess at what a model
 * would say.
 */
import type { GraphRehearsal } from "@graphloom/sdk";
import { BUMP_STAGE, CHANGELOG_PATH, CHANGELOG_STAGE, REVIEW_STAGE, VERSION_PATH } from "./constants.js";

/** writer-result-v1 is deliberately unconstrained ({type: "object"}, graph.ts: "the writer has nothing to say beyond 'I wrote it'"): every field below is the real model's own free choice, not something either prompt was obligated to ask for. */
const WRITER_HARNESS_SUPPLIED = ["status", "changed_paths", "version_file_contents", "changelog_added", "notes"];

export const rehearsal: GraphRehearsal = {
  scenarios: {
    happy: {
      results: {
        "writer-result-v1": [
          {
            output: {
              status: "done",
              changed_paths: [VERSION_PATH],
              version_file_contents: "1.0.0\n",
              notes:
                "Instructions conflicted: the task description asked to also add a CHANGELOG.md entry, but then explicitly restricted changes to 'Change only these paths: VERSION.' I honored the explicit restriction and only wrote VERSION (verified exact content '1.0.0\\n' via cat -A, and git status shows only VERSION as untracked/changed). No CHANGELOG.md was created or modified — flag this back to the requester if a changelog entry is actually required.",
            },
            harnessSupplied: WRITER_HARNESS_SUPPLIED,
            effects: [{ path: VERSION_PATH, bytes: "1.0.0\n" }],
          },
          {
            output: {
              status: "success",
              changed_paths: [CHANGELOG_PATH],
              changelog_added: "## [1.0.0] - 2026-10-04\n\n- Initial release",
              notes:
                "VERSION already existed (untracked) with content '1.0.0' prior to this task; per the instruction restricting changes to CHANGELOG.md only, it was left untouched. CHANGELOG.md did not exist, so it was created with a header and the 1.0.0 section (no prior '## [Unreleased]' or older release sections to position it against). The only repo history is a single 'init' commit adding README.md, so the changelog bullet reflects that as the initial release.",
            },
            harnessSupplied: WRITER_HARNESS_SUPPLIED,
            // The controller's own file evidence for this dispatch includes
            // VERSION again (unchanged bytes, from the Bump stage before it);
            // replaying it is a no-op, not a scope violation — the fingerprint
            // this stage's own diff compares against is identical either way.
            effects: [
              { path: VERSION_PATH, bytes: "1.0.0\n" },
              { path: CHANGELOG_PATH, bytes: "# Changelog\n\n## [1.0.0] - 2026-10-04\n\n- Initial release\n" },
            ],
          },
        ],
        "review-verdict-v1": [
          {
            output: {
              verdict: "approved",
              summary:
                "VERSION contains exactly '1.0.0'. CHANGELOG.md includes a '## [1.0.0] - 2026-10-04' entry describing it as the 'Initial release', which is dated correctly (today) and accurately reflects a 1.0.0 release. Both files match the requested release.",
            },
          },
        ],
      },
      expect: { status: "succeeded", receipts: [BUMP_STAGE, CHANGELOG_STAGE, REVIEW_STAGE] },
    },
  },
};
