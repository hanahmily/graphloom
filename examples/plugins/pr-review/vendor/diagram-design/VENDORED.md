# diagram-design (vendored)

- Name: diagram-design
- Source: https://github.com/cathrynlavery/diagram-design
- Commit: 0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1
- License: MIT (see `LICENSE`, copied from the repository root; copyright 2025 Cathryn Lavery)

Copied unmodified from the source repository, so the SPDX header check skips this
directory (`vendor/` is exempt in `scripts/check-headers.mjs`).

| Here | In the source repository |
|---|---|
| `SKILL.md`, `references/*.md`, `assets/*.html` | `skills/diagram-design/` (the same names) |
| `scripts/self_check.py` | `skills/diagram-design/scripts/self_check.py` |
| `scripts/verify-geometry.py` | `scripts/verify-geometry.py` (the repository root, not the skill directory) |

Kept: `SKILL.md`; the references the `diagrams-v1` job reads (`type-architecture-delta.md`,
`type-state.md`, `style-guide.md`, `primitives-core.md`, `output-spec.md`, `layout-budget.md`) and the
ones `SKILL.md` routes through (`type-architecture.md`, `semantic-patterns.md`, `profiles.md`,
`primitive-annotation.md`); the light minimal `template.html` and the two examples of the types drawn
(`example-architecture-delta.html`, `example-state.html`); and the two checks the plugin runs
(`self_check.py`, `verify-geometry.py`; both import only the Python standard library).

Left out: the other 40 type references, the icon set, the import and export references and scripts,
the dark and full templates and every other example, and the screenshots and gallery assets. Links in
`SKILL.md` to those files do not resolve here; the job's instruction names the files it needs.

To update, copy the same files from a newer commit, change the commit above, and regenerate the plugin
manifest (`npm run manifest -w @graphloom/plugin-pr-review`).
