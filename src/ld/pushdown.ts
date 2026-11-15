/**
 * Turn DuckDB's pushed-down WHERE predicates into LaunchDarkly request parameters.
 *
 * Every table function here sets `autoApplyFilters: true`, so the SDK re-applies
 * every pushed predicate to each batch exactly. Translation therefore only has to
 * NARROW the upstream request without ever dropping a matching row: predicates we
 * cannot express are simply not sent, and anything LaunchDarkly matches more loosely
 * (for example `filter=query:` substring matching for an exact key) is tightened
 * again by the SDK.
 *
 * Only top-level conjuncts are translated (a predicate under OR/NOT is left to the
 * SDK), so every generated parameter is implied by the SQL filter.
 */

import type { PushdownFilters } from "@query-farm/vgi";

type Expr = PushdownFilters["filters"][number];

/** One translatable constraint on a column. */
export type Constraint =
  | { kind: "cmp"; column: string; op: "eq" | "gt" | "ge" | "lt" | "le"; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "contains"; column: string; value: string };

const FLIP: Record<string, "eq" | "gt" | "ge" | "lt" | "le"> = { eq: "eq", gt: "lt", ge: "le", lt: "gt", le: "ge" };

function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

function one(e: Expr, out: Constraint[]): void {
  // A bare boolean column (`WHERE temporary`) and its negation.
  if (e.node === "column_ref") {
    out.push({ kind: "cmp", column: e.columnName, op: "eq", value: true });
    return;
  }
  if (e.node === "not" && unwrap(e.expression).node === "column_ref") {
    const c = unwrap(e.expression) as Extract<Expr, { node: "column_ref" }>;
    out.push({ kind: "cmp", column: c.columnName, op: "eq", value: false });
    return;
  }
  if (e.node === "and") {
    for (const c of e.children) one(c, out);
    return;
  }
  if (e.node === "comparison" && e.op in FLIP) {
    const [l, r] = [unwrap(e.left), unwrap(e.right)];
    if (l.node === "column_ref" && r.node === "literal" && r.value != null) {
      out.push({ kind: "cmp", column: l.columnName, op: e.op as "eq", value: r.value });
    } else if (r.node === "column_ref" && l.node === "literal" && l.value != null) {
      out.push({ kind: "cmp", column: r.columnName, op: FLIP[e.op] ?? "eq", value: l.value });
    }
    return;
  }
  if (e.node === "in" && !e.negated && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    const values = e.set.values.filter((v) => v != null);
    if (col.node === "column_ref" && values.length > 0 && values.length === e.set.values.length) {
      out.push({ kind: "in", column: col.columnName, values });
    }
    return;
  }
  // list_contains(tags, 'beta') (DuckDB normalises list_has / array_contains to it).
  if (e.node === "call" && e.function === "list_contains" && e.arguments.length === 2) {
    const [c, v] = [unwrap(e.arguments[0] as Expr), unwrap(e.arguments[1] as Expr)];
    if (c.node === "column_ref" && v.node === "literal" && typeof v.value === "string") {
      out.push({ kind: "contains", column: c.columnName, value: v.value });
    }
  }
}

/** The top-level, translatable constraints of a scan's pushed filters. */
export function constraintsOf(filters: PushdownFilters | undefined): Constraint[] {
  const out: Constraint[] = [];
  for (const f of filters?.filters ?? []) one(f, out);
  return out;
}

/** A pushed literal for a TIMESTAMPTZ column as epoch milliseconds (µs bigint, ms number, Date, ISO). */
export function toEpochMs(v: unknown): number | undefined {
  if (typeof v === "bigint") return Number(v) / 1000;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * The tightest bounds the constraints put on a time column, as LaunchDarkly's
 * exclusive `after` / `before` epoch-ms parameters (inclusive SQL bounds widen by 1 ms).
 */
export function timeBounds(constraints: Constraint[], column: string): { after?: number; before?: number } {
  let after: number | undefined;
  let before: number | undefined;
  for (const c of constraints) {
    if (c.column !== column || c.kind !== "cmp") continue;
    const ms = toEpochMs(c.value);
    if (ms === undefined) continue;
    // LaunchDarkly times are whole milliseconds; sub-millisecond literals round so the
    // window only ever widens.
    if (c.op === "gt" || c.op === "ge" || c.op === "eq") {
      const lo = c.op === "gt" ? Math.floor(ms) : Math.ceil(ms) - 1;
      after = after === undefined ? lo : Math.max(after, lo);
    }
    if (c.op === "lt" || c.op === "le" || c.op === "eq") {
      const hi = c.op === "lt" ? Math.ceil(ms) : Math.floor(ms) + 1;
      before = before === undefined ? hi : Math.min(before, hi);
    }
  }
  return { after, before };
}

/** Equality / IN values pushed for a column (as strings), or undefined if unconstrained. */
export function eqValues(constraints: Constraint[], column: string): string[] | undefined {
  let set: string[] | undefined;
  for (const c of constraints) {
    if (c.column !== column) continue;
    let vs: string[] | undefined;
    if (c.kind === "cmp" && c.op === "eq" && typeof c.value === "string") vs = [c.value];
    else if (c.kind === "in" && c.values.every((v) => typeof v === "string")) vs = c.values as string[];
    if (!vs) continue;
    set = set ? set.filter((v) => vs.includes(v)) : [...new Set(vs)];
  }
  return set;
}

/** The single equality value pushed for a column, if exactly one. */
export function eqOne(constraints: Constraint[], column: string): string | undefined {
  const vs = eqValues(constraints, column);
  return vs && vs.length === 1 ? vs[0] : undefined;
}

/** A pushed `col = true/false` (or bare boolean column), if any. */
export function eqBool(constraints: Constraint[], column: string): boolean | undefined {
  for (const c of constraints) {
    if (c.column === column && c.kind === "cmp" && c.op === "eq" && typeof c.value === "boolean") return c.value;
  }
  return undefined;
}

/** Every `list_contains(col, 'x')` value pushed for a list column. */
export function containsValues(constraints: Constraint[], column: string): string[] {
  const out: string[] = [];
  for (const c of constraints) if (c.column === column && c.kind === "contains") out.push(c.value);
  return [...new Set(out)];
}

/** Quote a value for LaunchDarkly's operator filter syntax (`field equals "v"`). */
export const jsonQuote = (v: string): string => JSON.stringify(v);

/** `field anyOf ["a","b"]` for the operator filter syntax (segments, approvals, metrics). */
export const anyOf = (field: string, values: string[]): string => `${field} anyOf [${values.map(jsonQuote).join(",")}]`;

/** Values usable in the `field:value` filter syntax (no separators that would split the filter). */
export function plainValue(v: string): boolean {
  return v !== "" && !/[,+|{}]/.test(v);
}
