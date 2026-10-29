// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { DetectorConfig, Profile } from "./profile.js";

/** A report section as the run uses it: the default template with the profile's mapping applied (design §6.1, §6.2). */
export interface Section {
  id: string;
  title: string;
  meaning: string;
  routing: string[];
  detectors: DetectorConfig[];
  /** Part of the maintainer's template, which a profile may retitle but not remove. */
  required: boolean;
}

const BASE: ReadonlyArray<Pick<Section, "id" | "title" | "meaning">> = [
  { id: "schema", title: "Database / storage schema changes (tables, columns, indexes, migrations)", meaning: "Schema definitions, persisted formats and migrations." },
  { id: "background", title: "Scheduled jobs, cron, background workers", meaning: "Anything that runs on a schedule or in the background." },
  { id: "features", title: "Every feature added or modified", meaning: "Behaviour the change adds or alters." },
  { id: "external", title: "New external services, APIs, or third-party libraries", meaning: "New dependencies and integrations." },
  { id: "config", title: "New environment variables or config flags", meaning: "Settings an operator can change." },
  { id: "interfaces", title: "New public endpoints or interfaces", meaning: "Public APIs and endpoints." },
  { id: "removed", title: "Anything deleted or deprecated", meaning: "Deleted files and declarations, and deprecation markers." },
];
const OTHER: Pick<Section, "id" | "title" | "meaning"> = { id: "other", title: "Other changes", meaning: "Tests, docs, build files and refactors that fit no other section." };
const CLAIMS: Pick<Section, "id" | "title" | "meaning"> = { id: "claims", title: "What the PR says vs what it changes", meaning: "Only factual mismatches between the PR's own text and the diff. Each entry quotes and cites, and judges neither side." };
const MEASUREMENTS: Pick<Section, "id" | "title" | "meaning"> = { id: "measurements", title: "Measurements", meaning: "Built by the graph from measurement records; the reporter does not write it." };

/** Sections whose items the reporter writes: the template without Measurements. */
export function reporterSections(profile: Pick<Profile, "sections">): Section[] {
  return templateFor(profile).filter((s) => s.id !== MEASUREMENTS.id);
}

/**
 * The run's section list: the template in the maintainer's order, each
 * section retitled, given its repository meaning, routing and detectors by
 * the profile; profile-added sections sit before `other`, and `claims` and
 * `measurements` stay last.
 */
export function templateFor(profile: Pick<Profile, "sections">): Section[] {
  const byId = new Map(profile.sections.map((s) => [s.id, s]));
  const build = (b: Pick<Section, "id" | "title" | "meaning">, required: boolean): Section => {
    const p = byId.get(b.id);
    return {
      id: b.id,
      title: p?.title ?? b.title,
      meaning: [b.meaning, p?.meaning].filter((t): t is string => t !== undefined && t !== "").join(" "),
      routing: p?.routing ?? [],
      detectors: p?.detectors ?? [],
      required,
    };
  };
  const known = new Set([...BASE.map((b) => b.id), OTHER.id, CLAIMS.id, MEASUREMENTS.id]);
  const added = profile.sections.filter((s) => !known.has(s.id)).map((s) => build({ id: s.id, title: s.id, meaning: "" }, false));
  return [...BASE.map((b) => build(b, true)), ...added, build(OTHER, true), build(CLAIMS, true), build(MEASUREMENTS, true)];
}
