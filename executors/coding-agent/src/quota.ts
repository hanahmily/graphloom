import { FAILURE_SHAPE } from "./transient.js";

/** A harness refusing work until its usage allowance renews; waiting out a backoff cannot fix it. */
export interface QuotaFailure {
  /** Short name of the cause, e.g. "usage limit". */
  reason: string;
  /** Absolute time the allowance renews, when the failure text states one. */
  resetAt?: string;
}

/** Wording of an allowance that renews on a schedule (a session, a billing period, a plan): quota on its own. */
const ALLOWANCE =
  /\b(?:session|usage|weekly|daily|monthly|5-hour|five-hour|opus|sonnet)[ -]limit\b|usage limit|insufficient_quota|exceeded your (?:current )?quota/i;
/** Wording that only says a quota or resource ran out: a per-minute rate limit says it too, so it needs more evidence. */
const AMBIGUOUS = /quota (?:exceeded|exhausted|has been exceeded)|RESOURCE_EXHAUSTED/i;
/** A short-window rate limit, which the transient backoff handles. */
const RATE_WINDOW = /per[ -]?(?:minute|second)|\b(?:rpm|tpm)\b|rate[ _-]?limit/i;
/** An ambiguous failure is a usage allowance only when its stated reset is farther than a backoff could wait. */
const FAR_RESET_MS = 5 * 60_000;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 86_400_000;

interface Zoned {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function partsIn(ms: number, timeZone: string | undefined): Zoned {
  const f = new Intl.DateTimeFormat("en-US", {
    ...(timeZone !== undefined ? { timeZone } : {}),
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! % 24, mi: p.minute! };
}

/** The UTC instant at which `timeZone`'s (or the local) wall clock reads `z`. */
function instantOf(z: Zoned, timeZone: string | undefined): number {
  const wall = Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi);
  let guess = wall;
  // Two passes settle the offset across a DST change.
  for (let i = 0; i < 2; i++) {
    const seen = partsIn(guess, timeZone);
    guess += wall - Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi);
  }
  return guess;
}

function validZone(tz: string): string | undefined {
  const name = /^(?:utc|gmt|z)$/i.test(tz) ? "UTC" : tz;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

const DURATION_UNITS: Array<[RegExp, number]> = [
  [/(\d+(?:\.\d+)?)\s*(?:days?|d)(?![a-z])/i, DAY_MS],
  [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])/i, 3_600_000],
  [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)(?![a-z])/i, 60_000],
  [/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)(?![a-z])/i, 1_000],
];

/** "3 days 4 hours 5 minutes", "1h30m", "34.5s" as milliseconds. */
function durationMs(text: string): number | undefined {
  let total = 0;
  let found = false;
  for (const [re, unit] of DURATION_UNITS) {
    const m = re.exec(text);
    if (m !== null) {
      total += Number(m[1]) * unit;
      found = true;
    }
  }
  return found ? Math.round(total) : undefined;
}

/**
 * The renewal time a quota failure states, as an absolute instant. Handles an
 * epoch (`limit reached|1760000000`), a clock time with an optional date and
 * zone (`resets 12:20pm (UTC)`, `resets Oct 28, 9am (America/New_York)`,
 * `try again at 3:45 PM`), a relative wait (`try again in 3 days 4 hours`,
 * `quota will reset after 30s`), and an ISO timestamp. A clock time with no
 * date is its next occurrence: later today, else tomorrow. No zone means the
 * process's local zone.
 */
export function parseResetAt(text: string, now: Date = new Date()): Date | undefined {
  const epoch = /\|\s*(\d{9,13})\b/.exec(text);
  if (epoch !== null) {
    const n = Number(epoch[1]);
    return new Date(n < 1e11 ? n * 1000 : n);
  }
  const iso = /reset[s]?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso !== null) {
    const t = Date.parse(iso[1]!);
    if (Number.isFinite(t)) return new Date(t);
  }
  const rel = /(?:reset[s]?|try again|retry)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[ ,and]*)+)/i.exec(text);
  if (rel !== null) {
    const ms = durationMs(rel[1]!);
    if (ms !== undefined) return new Date(now.getTime() + ms);
  }
  const clock =
    /(?:reset[s]?|try again|retry)\s+(?:at\s+)?(?:(?:on\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+\-0-9]+)*)\))?/i.exec(text);
  if (clock === null) return undefined;
  const [, monthName, dayText, yearText, hourText, minText, meridiem, zoneText] = clock;
  const zone = zoneText !== undefined ? validZone(zoneText) : undefined;
  if (zoneText !== undefined && zone === undefined) return undefined;
  let hour = Number(hourText) % 12;
  if (meridiem!.toLowerCase() === "pm") hour += 12;
  const minute = minText !== undefined ? Number(minText) : 0;
  if (Number(hourText) < 1 || Number(hourText) > 12 || minute > 59) return undefined;
  const today = partsIn(now.getTime(), zone);
  if (monthName !== undefined) {
    const mo = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase()) + 1;
    if (mo === 0) return undefined;
    const z: Zoned = { y: yearText !== undefined ? Number(yearText) : today.y, mo, d: Number(dayText), h: hour, mi: minute };
    let at = instantOf(z, zone);
    if (yearText === undefined && at <= now.getTime()) at = instantOf({ ...z, y: z.y + 1 }, zone);
    return new Date(at);
  }
  let at = instantOf({ ...today, h: hour, mi: minute }, zone);
  if (at <= now.getTime()) {
    const next = partsIn(Date.UTC(today.y, today.mo - 1, today.d) + DAY_MS, "UTC");
    at = instantOf({ ...next, h: hour, mi: minute }, zone);
  }
  return new Date(at);
}

/** Classifies a failed run's summary as a usage-limit failure, per harness; undefined when it is not one. */
export function classifyQuota(harness: string, summary: string, now: Date = new Date()): QuotaFailure | undefined {
  const shape = FAILURE_SHAPE[harness];
  if (shape === undefined || !shape.test(summary)) return undefined;
  const allowance = ALLOWANCE.test(summary);
  if (!allowance && (!AMBIGUOUS.test(summary) || RATE_WINDOW.test(summary))) return undefined;
  const at = parseResetAt(summary, now);
  const resetAt = at !== undefined && Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
  if (!allowance && (at === undefined || at.getTime() - now.getTime() < FAR_RESET_MS)) return undefined;
  const reason = /insufficient_quota|quota|RESOURCE_EXHAUSTED/i.test(summary) ? "provider quota" : "usage limit";
  return resetAt !== undefined ? { reason, resetAt } : { reason };
}
