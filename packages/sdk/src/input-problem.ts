/**
 * The first way `value` fails a JSON Schema, as a path and a rule, or undefined
 * when it satisfies it. Covers the subset executors declare their inputs with:
 * type, required, properties, enum, pattern, string and array lengths, numeric
 * bounds, and items. Keys the schema does not list are not checked. It only
 * explains a refusal; an executor's own predicate stays authoritative.
 */
export function jsonSchemaProblem(schema: Record<string, unknown>, value: unknown, at = ""): string | undefined {
  const where = at === "" ? "input" : at;
  const type = schema["type"];
  if (typeof type === "string" && !hasType(type, value)) return `${where}: must be ${article(type)}`;
  const options = schema["enum"];
  if (Array.isArray(options) && !options.includes(value)) {
    return `${where}: must be one of ${options.map((o) => JSON.stringify(o)).join(", ")}`;
  }
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      return `${where}: must be at least ${schema["minLength"]} character(s)`;
    }
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
      return `${where}: must be at most ${schema["maxLength"]} characters`;
    }
    if (typeof schema["pattern"] === "string" && !new RegExp(schema["pattern"]).test(value)) {
      return `${where}: must match ${schema["pattern"]}`;
    }
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) return `${where}: must be at least ${schema["minimum"]}`;
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) return `${where}: must be at most ${schema["maximum"]}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) return `${where}: must hold at least ${schema["minItems"]} item(s)`;
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) return `${where}: must hold at most ${schema["maxItems"]} items`;
    const items = schema["items"];
    if (items !== null && typeof items === "object" && !Array.isArray(items)) {
      for (const [i, item] of value.entries()) {
        const problem = jsonSchemaProblem(items as Record<string, unknown>, item, `${at}[${i}]`);
        if (problem !== undefined) return problem;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
    for (const key of required) {
      if (o[key] === undefined) return `${at === "" ? "" : `${at}.`}${key}: required`;
    }
    const properties = schema["properties"];
    if (properties !== null && typeof properties === "object") {
      for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
        if (o[key] === undefined || sub === null || typeof sub !== "object") continue;
        const problem = jsonSchemaProblem(sub as Record<string, unknown>, o[key], `${at === "" ? "" : `${at}.`}${key}`);
        if (problem !== undefined) return problem;
      }
    }
  }
  return undefined;
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function article(type: string): string {
  return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}
