// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The areas of a large report and the way into one (design §6.9): the report is high level, and the way into an area is
 * a conversation with the reporter, whose session already holds the pull request's digest and can read any file. The run
 * id is not in what a validator sees, so the command says `<run>`.
 */
export const DIVE_HEADING = "Dive into an area";
export const DIVE_COMMAND = "graphloom session open <run> --stage report";
export const DIVE_TEXT = "This report is high level: large mode does not read the detail of each area. To dig into an area, talk to the reporter, whose session already has the pull request's digest and can read any file of the head or the base:";
/** The line under the section list of a report with no areas to show. */
export const DIVE_LINE = "To ask the reporter about any of this, whose session already holds the pull request and can read any file of the head or the base:";

/** An area as a row of the areas table. */
export interface DiveArea {
  id: string;
  name: string;
  kind: "read" | "generated";
  paths: string[];
  bytes?: number;
  additions?: number;
  deletions?: number;
}

/** id, what it is (the reporter's label, else the area's path), files, lines added and deleted. */
export function diveRow(a: DiveArea, label?: string): string[] {
  const what = label !== undefined && label.trim() !== "" ? label : a.name;
  return [a.id, a.kind === "generated" ? `${what} (generated)` : what, String(a.paths.length), `+${a.additions ?? 0} −${a.deletions ?? 0}`];
}

export const DIVE_COLUMNS: readonly string[] = ["Area", "What it is", "Files", "Lines"];
