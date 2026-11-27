// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** A UTC instant: `YYYY-MM-DDTHH:MM:SS` with an optional fraction, ending in `Z`. */
export const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True when the "YYYY-MM-DD" prefix names a real calendar date (round-trips through Date.UTC). */
export function realDay(text: string): boolean {
  const [y, m, d] = [Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10))];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCFullYear(y); // years 0-99 map to 1900-1999 in the constructor
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** True for a real UTC calendar instant: no 02-30, no hour 24, no minute or second 60. */
export function validInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value) || !realDay(value)) return false;
  const [h, mi, sec] = [Number(value.slice(11, 13)), Number(value.slice(14, 16)), Number(value.slice(17, 19))];
  return h <= 23 && mi <= 59 && sec <= 59;
}
