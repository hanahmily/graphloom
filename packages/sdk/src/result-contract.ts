/**
 * A plugin-declared shape for one kind of agent result. The SDK ships no
 * names and no schemas: a plugin lists its own contracts in its
 * GraphDefinition, and the controller applies them mechanically — comparing
 * strings the plugin gave it, never a name or schema it knows itself. See
 * docs/design-agent-contract-robustness.md.
 */
export interface ResultContract {
  /** The plugin's own name for this shape; what JobSpec.resultSchema and a requirement's evidenceSchema reference. */
  name: string;
  /** JSON Schema (the subset validateResultShape checks) the model's structured result is constrained to and validated against. */
  schema: Record<string, unknown>;
  /** The SDK evidence kind a result satisfying this contract is recorded as. */
  evidenceKind: "file" | "command" | "workspace" | "review" | "other";
  /**
   * Dot/`[]` paths into the result (e.g. "findings[].finding") whose values
   * must come from the id set the dispatching job supplies in
   * JobSpec.knownReferences for that same path. A path segment ending in
   * `[]` iterates an array; the path's last segment names the leaf field.
   */
  references?: string[];
}

/** Per-dispatch valid values for one reference path. */
export interface ReferenceSet {
  /** Values the field may legitimately hold (often includes "" for "this is new"). */
  ids: string[];
  /** id -> the description shown to the agent for it, for reconciling a value that names the thing instead of its id. */
  descriptions?: Record<string, string>;
}

export interface ContractCheck {
  status: "valid" | "invalid" | "repaired";
  /** Empty when status is "valid". */
  problems: string[];
  /** Present when status is "repaired": what was substituted and why. */
  repairs?: string[];
  /** The checked value, with any §4.3 repairs applied. */
  value: unknown;
}

/**
 * Validates `value` against the JSON Schema subset this codebase's own
 * contracts use: type, properties, required, additionalProperties, enum,
 * items, and plain string/number/integer/boolean/array/object types. Not a
 * general JSON Schema implementation — adding a keyword some contract
 * actually needs is expected; silently ignoring one that changes validity is
 * not.
 */
export function validateResultShape(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  const problems: string[] = [];
  checkNode(value, schema, path, problems);
  return problems;
}

function checkNode(value: unknown, schema: Record<string, unknown>, path: string, problems: string[]): void {
  const type = schema.type as string | undefined;
  if (type !== undefined && !matchesType(value, type)) {
    problems.push(`${path} must be ${type}, got ${describeType(value)}`);
    return;
  }
  if (type === "object" || (type === undefined && isPlainObject(value))) {
    checkObject(value, schema, path, problems);
  } else if (type === "array" || (type === undefined && Array.isArray(value))) {
    checkArray(value, schema, path, problems);
  }
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues !== undefined && !enumValues.some((e) => Object.is(e, value) || e === value)) {
    problems.push(`${path} must be one of ${enumValues.map((e) => JSON.stringify(e)).join(", ")}, got ${JSON.stringify(value)}`);
  }
}

function checkObject(value: unknown, schema: Record<string, unknown>, path: string, problems: string[]): void {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be object, got ${describeType(value)}`);
    return;
  }
  const required = (schema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (!(key in value)) problems.push(`${path}.${key} is required`);
  }
  const properties = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) problems.push(`${path}.${key} is not an allowed property`);
    }
  }
  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in value) checkNode(value[key], propSchema, `${path}.${key}`, problems);
  }
}

function checkArray(value: unknown, schema: Record<string, unknown>, path: string, problems: string[]): void {
  if (!Array.isArray(value)) {
    problems.push(`${path} must be array, got ${describeType(value)}`);
    return;
  }
  const items = schema.items as Record<string, unknown> | undefined;
  if (items !== undefined) {
    value.forEach((item, i) => checkNode(item, items, `${path}[${i}]`, problems));
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One path segment: a field name, optionally iterating an array ("findings[]" -> name "findings", array true). */
export interface PathSegment {
  name: string;
  array: boolean;
}

export function parsePath(path: string): PathSegment[] {
  return path.split(".").map((raw) => {
    const array = raw.endsWith("[]");
    return { name: array ? raw.slice(0, -2) : raw, array };
  });
}

/**
 * Narrows `schema` at each `references` path with a known id set to
 * `enum: ids` (§4.3), so a model constrained to the result schema at
 * dispatch time (B2) cannot write a reference value outside the set it was
 * shown. A path the schema does not declare is left untouched.
 */
export function applyReferenceEnums(
  schema: Record<string, unknown>,
  references: string[] | undefined,
  known: Record<string, ReferenceSet> | undefined,
): Record<string, unknown> {
  if (references === undefined || known === undefined) return schema;
  let result = schema;
  for (const path of references) {
    const set = known[path];
    if (set === undefined) continue;
    result = narrowAtPath(result, parsePath(path), set.ids);
  }
  return result;
}

function narrowAtPath(node: Record<string, unknown>, segments: PathSegment[], ids: string[]): Record<string, unknown> {
  if (segments.length === 0) return { ...node, enum: ids };
  const [head, ...rest] = segments;
  const properties = isPlainObject(node.properties) ? (node.properties as Record<string, unknown>) : undefined;
  const child = properties?.[head!.name];
  if (!isPlainObject(child)) return node;
  if (head!.array) {
    const items = isPlainObject(child.items) ? (child.items as Record<string, unknown>) : {};
    return { ...node, properties: { ...properties, [head!.name]: { ...child, items: narrowAtPath(items, rest, ids) } } };
  }
  return { ...node, properties: { ...properties, [head!.name]: narrowAtPath(child, rest, ids) } };
}

/**
 * Checks every value `references` paths reach against the matching
 * ReferenceSet, reconciling an unrecognised value that exactly (or up to
 * whitespace) matches a shown description instead of its id, and reports
 * everything else as a problem. Mutates nothing; returns the value with any
 * repairs applied as a new structure sharing what did not change.
 */
export function checkReferences(
  value: unknown,
  references: string[],
  known: Record<string, ReferenceSet>,
): { problems: string[]; repairs: string[]; value: unknown } {
  const problems: string[] = [];
  const repairs: string[] = [];
  let result = value;
  for (const path of references) {
    const set = known[path];
    if (set === undefined) continue;
    result = walkAndCheck(result, parsePath(path), path, set, problems, repairs);
  }
  return { problems, repairs, value: result };
}

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

function walkAndCheck(
  node: unknown,
  segments: PathSegment[],
  fullPath: string,
  set: ReferenceSet,
  problems: string[],
  repairs: string[],
  at = "$",
): unknown {
  if (segments.length === 0) return node;
  const [head, ...rest] = segments;
  if (node === null || typeof node !== "object" || Array.isArray(node)) return node;
  const obj = node as Record<string, unknown>;
  if (!(head!.name in obj)) return node;
  const child = obj[head!.name];
  // The array flag names head.name's own value, so it must be navigated to
  // before it can be checked — not the parent object this call received.
  if (head!.array) {
    if (!Array.isArray(child)) return node;
    return {
      ...obj,
      [head!.name]: child.map((item, i) => walkAndCheck(item, rest, fullPath, set, problems, repairs, `${at}.${head!.name}[${i}]`)),
    };
  }
  if (rest.length > 0) {
    return { ...obj, [head!.name]: walkAndCheck(child, rest, fullPath, set, problems, repairs, `${at}.${head!.name}`) };
  }
  const leaf = child;
  const leafPath = `${at}.${head!.name}`;
  if (typeof leaf !== "string" || set.ids.includes(leaf)) return node;
  const normalized = normalize(leaf);
  const reconciled = Object.entries(set.descriptions ?? {}).find(([, desc]) => normalize(desc) === normalized);
  if (reconciled !== undefined) {
    repairs.push(`${fullPath} at ${leafPath}: "${leaf}" matches ${reconciled[0]}'s shown description; substituted ${reconciled[0]}`);
    return { ...obj, [head!.name]: reconciled[0] };
  }
  problems.push(`${fullPath} at ${leafPath} must be one of ${set.ids.map((i) => JSON.stringify(i)).join(", ")}, got ${JSON.stringify(leaf)}`);
  return node;
}

/**
 * The single check every consumer of a declared contract needs: does `value`
 * satisfy `contract.schema`, and — when the contract lists reference paths
 * and the caller supplies the id sets they must come from — does every
 * reference resolve or reconcile? One shared implementation so the
 * controller's live classification, a replay's reclassification, and a probe
 * never drift against each other on what "valid" means.
 */
export function checkContract(
  value: unknown,
  contract: Pick<ResultContract, "schema" | "references">,
  knownReferences?: Record<string, ReferenceSet>,
): ContractCheck {
  const problems = validateResultShape(value, contract.schema);
  if (problems.length > 0) return { status: "invalid", problems, value };
  if (contract.references === undefined || knownReferences === undefined) return { status: "valid", problems: [], value };
  const checked = checkReferences(value, contract.references, knownReferences);
  if (checked.problems.length > 0) return { status: "invalid", problems: checked.problems, value: checked.value };
  if (checked.repairs.length > 0) return { status: "repaired", problems: [], repairs: checked.repairs, value: checked.value };
  return { status: "valid", problems: [], value: checked.value };
}
