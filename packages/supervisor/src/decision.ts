import {
  WireValidationError,
  assertGraphDecision,
  type GraphDecision,
} from "@graphloom/sdk";

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Extract a GraphDecision from supervisor assistant text.
 * Prefers a fenced ```json``` block; otherwise parses the whole string as JSON.
 * Rejects Accept and other non-supervisor actions via assertGraphDecision.
 */
export function parseSupervisorDecision(text: string): GraphDecision {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new WireValidationError("malformed", "no GraphDecision JSON in supervisor response");
  }

  const fenced = trimmed.match(FENCED_JSON);
  const candidates: string[] = [];
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  candidates.push(trimmed);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return assertGraphDecision(parsed);
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError instanceof WireValidationError) {
    throw lastError;
  }
  throw new WireValidationError(
    "malformed",
    "no GraphDecision JSON in supervisor response",
  );
}
