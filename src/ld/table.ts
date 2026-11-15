/**
 * One factory for every LaunchDarkly list endpoint.
 *
 * A spec names the columns (with a JSON extractor each), the scope it runs in
 * (account-wide, per project, per project + environment, or per project +
 * environment + flag), and how a scope plus the pushed filters become a request.
 * The factory turns that into a VGI table function that:
 *
 * - resolves the scopes once from named arguments (`project_key :=`,
 *   `environment_key :=`, `flag_key :=`) or pushed `= / IN` filters on the same
 *   columns, and otherwise lists every project / environment / flag;
 * - streams one LaunchDarkly page per Arrow batch;
 * - keeps its cursor (scope list, scope index, `offset` or audit-log `before`) in
 *   serializable state, so a scan resumes on any process over HTTP and survives
 *   rate-limit pauses;
 * - reads the `launchdarkly` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  struct,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, type LdConfig, LdError, ldGet, type QueryValue, SECRET_TYPE } from "./client.ts";
import { type Constraint, constraintsOf, eqValues } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable?: boolean;
  get: (row: Row) => unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: LaunchDarkly JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
export const asBig = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** LaunchDarkly UnixMillis → TIMESTAMPTZ microseconds. */
export function asMs(v: unknown): bigint | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? BigInt(Math.trunc(v)) * 1000n : null;
}
/** ISO 8601 → TIMESTAMPTZ microseconds. */
export function asIso(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
}
/** A JSON value as text: strings as-is, everything else JSON-encoded. */
export const asText = (v: unknown): string | null =>
  v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x !== undefined).map((x) => asText(x) as string) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

type Getter = string | ((r: Row) => unknown);
const read = (r: Row, g: Getter) => (typeof g === "string" ? at(r, g) : g(r));

function mkCol(
  name: string,
  type: VgiDataType,
  sqlType: string,
  doc: string,
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  return { name, type, sqlType, doc, get, nullable };
}

/** A field of a STRUCT column: its Arrow type, DuckDB spelling and converter. */
export interface StructField {
  name: string;
  kind: "str" | "int" | "bool" | "strList" | "text";
  get: Getter;
}

const FIELD_TYPES: Record<StructField["kind"], [() => VgiDataType, string, (v: unknown) => unknown]> = {
  str: [() => utf8(), "VARCHAR", asStr],
  text: [() => utf8(), "VARCHAR", asText],
  int: [() => int32, "INTEGER", asInt],
  bool: [() => bool, "BOOLEAN", asBool],
  strList: [() => list(utf8()), "VARCHAR[]", asStrList],
};

const structType = (fields: StructField[]) =>
  struct(fields.map((f) => field(f.name, FIELD_TYPES[f.kind][0]())) as never);
const structSql = (fields: StructField[]) =>
  `STRUCT(${fields.map((f) => `${f.name} ${FIELD_TYPES[f.kind][1]}`).join(", ")})`;
const structValue = (fields: StructField[], item: Row, idx: number) =>
  Object.fromEntries(
    fields.map((f) => [
      f.name,
      FIELD_TYPES[f.kind][2](typeof f.get === "string" && f.get === "#" ? idx : read(item, f.get)),
    ]),
  );

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => asStr(read(r, g)), nullable),
  /** A JSON value of any type as text (strings unquoted). */
  text: (name: string, doc: string, g: Getter) => mkCol(name, utf8(), "VARCHAR", doc, (r) => asText(read(r, g))),
  ms: (name: string, doc: string, g: Getter) =>
    mkCol(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asMs(read(r, g))),
  iso: (name: string, doc: string, g: Getter) =>
    mkCol(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asIso(read(r, g))),
  bool: (name: string, doc: string, g: Getter, nullable = true) =>
    mkCol(name, bool, "BOOLEAN", doc, (r) => asBool(read(r, g)), nullable),
  int: (name: string, doc: string, g: Getter) => mkCol(name, int32, "INTEGER", doc, (r) => asInt(read(r, g))),
  big: (name: string, doc: string, g: Getter) => mkCol(name, int64(), "BIGINT", doc, (r) => asBig(read(r, g))),
  num: (name: string, doc: string, g: Getter) => mkCol(name, float64(), "DOUBLE", doc, (r) => asNum(read(r, g))),
  strList: (name: string, doc: string, g: Getter) =>
    mkCol(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(read(r, g))),
  json: (name: string, doc: string, g: Getter) => mkCol(name, utf8(), "JSON", doc, (r) => asJson(read(r, g))),
  /** A scope value (project_key / environment_key / flag_key) the row was read under. */
  ctx: (name: string, doc: string, key: string) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, false),
  /** A LaunchDarkly UI link (`_site.href`, relative) made absolute against the instance. */
  site: (name: string, doc: string, g: Getter) =>
    mkCol(name, utf8(), "VARCHAR", doc, (r) => {
      const href = read(r, g);
      return typeof href === "string" && href
        ? new URL(href, r.__ctx?.base_url ?? "https://app.launchdarkly.com").href
        : null;
    }),
  /** A list of structs; a field getter of "#" is the item's index in the list. */
  structList: (name: string, doc: string, fields: StructField[], g: Getter) =>
    mkCol(name, list(structType(fields)), `${structSql(fields)}[]`, doc, (r) => {
      const v = read(r, g);
      if (!Array.isArray(v)) return null;
      return v.map((item, i) => structValue(fields, item, i));
    }),
};

// --------------------------------------------------------------------- the factory

/** Where a spec runs: once, once per project, per project + environment, or per flag too. */
export type ScopeKind = "account" | "project" | "env" | "flag-env";

export interface Scope {
  project_key: string;
  environment_key: string;
  flag_key: string;
}

/** The first request for one scope. */
export interface LdRequest {
  path: string;
  query?: Record<string, QueryValue>;
  /**
   * `offset`: limit/offset pages until a short page (or `totalCount`) ends it;
   * `before`: the audit log's descending time cursor; `single`: one response.
   */
  paging: "offset" | "before" | "single";
  /** Page size sent as `limit` (offset and before paging). */
  limit?: number;
}

export interface ScanContext<A> {
  args: A;
  constraints: Constraint[];
  /** Wall-clock anchor fixed when the scan started (epoch ms), stable across resumes. */
  anchorMs: number;
}

export interface FnExample {
  sql: string;
  description: string;
}

export interface LdTableSpec<A> {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  scope: ScopeKind;
  /** Extra arguments (the scope arguments are added automatically). */
  args?: Record<string, VgiDataType>;
  argDocs?: Record<string, string>;
  argDefaults?: Record<string, unknown>;
  argConstraints?: Record<string, Record<string, unknown>>;
  columns: Col[];
  /** The request for one scope; null skips the scope (the filters exclude it). */
  request: (scope: Scope, ctx: ScanContext<A>) => LdRequest | null;
  /** Pull the rows out of a response body (default: `body.items`). */
  rows?: (body: unknown, scope: Scope) => Row[];
  /** Turn a page of rows into the emitted rows (flatten, or fetch details). */
  expand?: (rows: Row[], scope: Scope, cfg: LdConfig, ctx: ScanContext<A>) => Row[] | Promise<Row[]>;
  /** A 404 for a scope means "nothing there" → zero rows rather than an error. */
  notFoundEmpty?: boolean;
  /** Text appended to doc_md describing what pushes down. */
  pushdown?: string;
  examples: FnExample[];
}

interface ScanState {
  /** Scopes resolved on the first call: JSON array of [project, env, flag]; "" = not yet. */
  scopes: string;
  idx: number;
  /** Offset paging: the next offset within the current scope. */
  offset: number;
  /** `before` paging: the next `before` cursor (epoch ms as text); "" = first page. */
  cursor: string;
  anchorMs: number;
}

const ITEMS = (body: unknown): Row[] => {
  const items = (body as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as Row[]) : [];
};

const SCOPE_DOCS: Record<string, string> = {
  project_key:
    "Project key (named). NULL reads every project; a pushed WHERE project_key = / IN (...) works the same way.",
  environment_key:
    "Environment key (named). NULL reads every environment of each project; a pushed WHERE environment_key = / IN (...) works the same way.",
  flag_key:
    "Flag key (named). NULL reads every live flag of each project (one extra call per flag and environment); a pushed WHERE flag_key = / IN (...) works the same way.",
};

function scopeArgNames(kind: ScopeKind): (keyof Scope)[] {
  if (kind === "account") return [];
  if (kind === "project") return ["project_key"];
  if (kind === "env") return ["project_key", "environment_key"];
  return ["project_key", "environment_key", "flag_key"];
}

/** Page through an offset-paged list and collect every item's key. */
export async function listKeys(cfg: LdConfig, path: string, query: Record<string, QueryValue> = {}): Promise<string[]> {
  const keys: string[] = [];
  for (let offset = 0, guard = 0; guard < 1000; guard++) {
    const body = (await ldGet(cfg, path, { ...query, limit: "100", offset: String(offset) })) as Row;
    const items = ITEMS(body);
    for (const it of items) if (typeof it.key === "string") keys.push(it.key);
    offset += items.length;
    if (!hasMore(body, items.length, offset, 100)) break;
  }
  return keys;
}

function hasMore(body: Row | null, got: number, nextOffset: number, limit: number): boolean {
  if (got === 0) return false;
  const total = body?.totalCount ?? body?.total_count;
  if (typeof total === "number") return nextOffset < total;
  if (body?._links?.next) return true;
  return got >= limit;
}

const enc = encodeURIComponent;

/** Resolve the scopes of a scan from its arguments, pushed filters and listings. */
async function resolveScopes(
  kind: ScopeKind,
  cfg: LdConfig,
  args: Record<string, unknown>,
  constraints: Constraint[],
): Promise<[string, string, string][]> {
  if (kind === "account") return [["", "", ""]];
  const pick = (name: string): string[] | undefined =>
    typeof args[name] === "string" && args[name] !== "" ? [args[name] as string] : eqValues(constraints, name);
  const projectsExplicit = pick("project_key");
  const projects = projectsExplicit ?? (await listKeys(cfg, "/api/v2/projects"));
  const out: [string, string, string][] = [];
  for (const p of projects) {
    if (kind === "project") {
      out.push([p, "", ""]);
      continue;
    }
    const envExplicit = pick("environment_key");
    let envs: string[];
    if (envExplicit && projectsExplicit) envs = envExplicit;
    else {
      // Listed projects may not all have the requested environment: intersect.
      const all = await listKeys(cfg, `/api/v2/projects/${enc(p)}/environments`);
      envs = envExplicit ? all.filter((e) => envExplicit.includes(e)) : all;
    }
    if (kind === "env") {
      for (const e of envs) out.push([p, e, ""]);
      continue;
    }
    if (envs.length === 0) continue;
    const flags = pick("flag_key") ?? (await listKeys(cfg, `/api/v2/flags/${enc(p)}`, { summary: "true" }));
    for (const f of flags) for (const e of envs) out.push([p, e, f]);
  }
  return out;
}

/** The Arrow output schema of a spec (column comments ride along as field metadata). */
function outputSchemaOf<A>(spec: LdTableSpec<A>) {
  return schema(
    spec.columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable ?? true, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable ?? true),
    ),
  );
}

/** Discovery tags shared by a spec's function or table. */
function tagsOf<A>(spec: LdTableSpec<A>): Record<string, string> {
  return {
    domain: "feature-management",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: spec.docMd + (spec.pushdown ? `\n\n**Pushdown:** ${spec.pushdown}` : ""),
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
  };
}

/**
 * An account-wide spec with no arguments exposed as a catalog table
 * (`SELECT … FROM launchdarkly.main.members`). The scan function keeps every
 * capability (pushdown, paging, secrets) and is table-only.
 */
export function defineLdCatalogTable(spec: LdTableSpec<Record<string, never>>, primaryKey: string[]): TableDescriptor {
  const fn = defineLdTable({ ...spec, name: `${spec.name}_scan` });
  const record = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY", columns: string[]) =>
    constraintRecord({
      schemaPath: ["main"],
      table: spec.name,
      id,
      kind,
      columns: columns.map((c) => [c]),
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  return {
    name: spec.name,
    comment: spec.description,
    columns: outputSchemaOf(spec),
    function: fn,
    constraints: [
      ...primaryKey.map((c) => record(`${c}_not_null`, "NOT_NULL", [c])),
      record("pk", "PRIMARY_KEY", primaryKey),
    ],
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

export function defineLdTable<A extends Record<string, unknown>>(spec: LdTableSpec<A>): VgiFunction {
  const outSchema = outputSchemaOf(spec);
  const extract = spec.rows ?? ITEMS;
  const scopeArgs = scopeArgNames(spec.scope);
  const args: Record<string, VgiDataType> = {};
  const argDocs: Record<string, string> = {};
  const argDefaults: Record<string, unknown> = {};
  for (const a of scopeArgs) {
    args[a] = utf8();
    argDocs[a] = SCOPE_DOCS[a] as string;
    argDefaults[a] = null;
  }
  Object.assign(args, spec.args ?? {});
  Object.assign(argDocs, spec.argDocs ?? {});
  Object.assign(argDefaults, spec.argDefaults ?? {});

  return defineTableFunction<A, ScanState>({
    name: spec.name,
    description: spec.description,
    args,
    argDocs,
    argDefaults,
    argConstraints: spec.argConstraints as never,
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what LaunchDarkly returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ scopes: "", idx: 0, offset: 0, cursor: "", anchorMs: Date.now() }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const scan: ScanContext<A> = {
        args: params.args,
        constraints: constraintsOf(params.pushdownFilters),
        anchorMs: state.anchorMs,
      };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
      if (!state.scopes) {
        state.scopes = JSON.stringify(
          await resolveScopes(spec.scope, cfg, params.args as Record<string, unknown>, scan.constraints),
        );
      }
      const scopes = JSON.parse(state.scopes) as [string, string, string][];

      const emit = async (rows: Row[], scope: Scope): Promise<boolean> => {
        let tagged = rows.map((r) => ({ ...r, __ctx: { ...scope, base_url: cfg.baseUrl } as Record<string, string> }));
        if (spec.expand && tagged.length) {
          tagged = (await spec.expand(tagged, scope, cfg, scan)).map((r) => ({
            ...r,
            __ctx: { ...scope, base_url: cfg.baseUrl } as Record<string, string>,
          }));
        }
        if (tagged.length === 0) return false;
        const cols: Record<string, unknown[]> = {};
        for (const f of params.outputSchema.fields) {
          const c = spec.columns.find((x) => x.name === f.name);
          cols[f.name] = c ? tagged.map((r) => c.get(r)) : tagged.map(() => null);
        }
        out.emit(batchFromColumns(cols, params.outputSchema));
        return true;
      };
      const nextScope = () => {
        state.idx += 1;
        state.offset = 0;
        state.cursor = "";
      };

      // Loop until a page yields rows or the scan ends, so no empty batches go out.
      for (;;) {
        const s = scopes[state.idx];
        if (!s) {
          out.finish();
          return;
        }
        const scope: Scope = { project_key: s[0], environment_key: s[1], flag_key: s[2] };
        const req = spec.request(scope, scan);
        if (!req) {
          nextScope();
          continue;
        }
        const query: Record<string, QueryValue> = { ...(req.query ?? {}) };
        const limit = req.limit ?? 100;
        if (req.paging === "offset") {
          query.limit = String(limit);
          query.offset = String(state.offset);
        } else if (req.paging === "before") {
          query.limit = String(limit);
          if (state.cursor) query.before = state.cursor;
        }
        let body: Row | null;
        try {
          body = (await ldGet(cfg, req.path, query)) as Row | null;
        } catch (err) {
          if (spec.notFoundEmpty && err instanceof LdError && err.status === 404) {
            nextScope();
            continue;
          }
          throw err;
        }
        const rows = extract(body, scope);
        if (req.paging === "offset") {
          const got = ITEMS(body).length || rows.length;
          state.offset += got;
          if (!hasMore(body, got, state.offset, limit)) nextScope();
        } else if (req.paging === "before") {
          const next = nextBefore(body, rows, limit, state.cursor);
          if (next) state.cursor = next;
          else nextScope();
        } else {
          nextScope();
        }
        if (await emit(rows, scope)) return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
}

/**
 * The audit log's next `before` cursor: the `before` of `_links.next` when present,
 * else the oldest entry's date when the page was full; "" when the listing ended.
 */
export function nextBefore(body: Row | null, rows: Row[], limit: number, current: string): string {
  if (rows.length === 0) return "";
  const links = body?._links;
  if (links && typeof links === "object") {
    // LaunchDarkly's own paging links are authoritative: no `next`, no more pages.
    const href = links.next?.href;
    if (typeof href !== "string") return "";
    const b = new URL(href, "http://x").searchParams.get("before");
    if (b && /^\d+$/.test(b)) return b === current ? "" : b;
  } else if (rows.length < limit) return "";
  const dates = rows.map((r) => r.date).filter((d): d is number => typeof d === "number");
  if (dates.length === 0) return "";
  const min = String(Math.min(...dates));
  return min === current ? "" : min;
}
