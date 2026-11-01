// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The "Dive into an area" block that ends a large report (design §6.9): the report is high level, and the way into
 * an area is a conversation with the reporter, whose session already holds the pull request's digest and can read
 * any file. The run id is not in what a validator sees, so the command says `<run>`.
 */
export const DIVE_HEADING = "Dive into an area";
export const DIVE_COMMAND = "graphloom session open <run> --stage report";
export const DIVE_TEXT = "This report is high level: large mode does not read the detail of each area. To dig into an area, talk to the reporter, whose session already has the pull request's digest and can read any file of the head or the base:";

/** The areas as a block's table rows: id, name, files, lines added and deleted, patch bytes. */
export interface DiveArea {
  id: string;
  name: string;
  kind: "read" | "generated";
  paths: string[];
  bytes?: number;
  additions?: number;
  deletions?: number;
}

export function diveRow(a: DiveArea): string[] {
  return [a.id, a.kind === "generated" ? `${a.name} (generated)` : a.name, String(a.paths.length), `+${a.additions ?? 0} −${a.deletions ?? 0}`, String(a.bytes ?? 0)];
}

export const DIVE_COLUMNS: readonly string[] = ["Area", "Name", "Files", "Lines", "Patch bytes"];
