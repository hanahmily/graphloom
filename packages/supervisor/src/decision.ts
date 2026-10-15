import {
  ACTION_SPEC_KEYS,
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
    throw new WireValidationError("malformed", "the reply is neither a tool call nor GraphDecision JSON");
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
      return assertGraphDecision(nestActionFields(parsed));
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError instanceof WireValidationError) {
    throw lastError;
  }
  throw new WireValidationError(
    "malformed",
    "the reply is neither a tool call nor GraphDecision JSON",
  );
}

/** Models writing JSON by hand often put an action's fields beside its type. */
function nestActionFields(value: unknown): unknown {
  const action = (value as { action?: unknown } | null)?.action as Record<string, unknown> | undefined;
  if (action === null || typeof action !== "object" || Array.isArray(action) || typeof action.type !== "string") return value;
  const key = ACTION_SPEC_KEYS[action.type];
  if (key === undefined || action[key] !== undefined) return value;
  const { type, ...fields } = action;
  return { ...(value as object), action: { type, [key]: fields } };
}
