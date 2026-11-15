/**
 * The LaunchDarkly table functions and tables: one spec per REST API v2 endpoint.
 *
 * Everything is read-only. Environment SDK keys and mobile keys are never read into a
 * column; the environment `_id` is LaunchDarkly's client-side ID, which is public by
 * design (it ships inside browser bundles), and is the only environment credential-like
 * value exposed.
 */

import { bool, int64, utf8, type VgiFunction } from "@query-farm/vgi";
import { type LdConfig, ldGet, type QueryValue } from "./client.ts";
import { anyOf, type Constraint, containsValues, eqBool, eqOne, eqValues, plainValue, timeBounds } from "./pushdown.ts";
import { at, C, defineLdCatalogTable, defineLdTable, type Row, type Scope } from "./table.ts";

const Q = "launchdarkly.main";
const enc = encodeURIComponent;
const PAGE_SIZE_DOC = "Rows requested per LaunchDarkly page (named; clamped to the endpoint's maximum).";
const DAY_MS = 86_400_000;

/** Clamp a page_size argument to an endpoint's maximum. */
const pageSize = (v: unknown, max: number) => Math.max(1, Math.min(Number(v ?? max), max));

/** Join `field:value` filter parts (flags, projects, environments, members, teams …). */
const colonFilter = (parts: (string | undefined)[]): string | undefined => {
  const p = parts.filter((x): x is string => !!x);
  return p.length ? p.join(",") : undefined;
};

const PROJECT_COL = C.ctx("project_key", "The project key the row belongs to.", "project_key");
const ENV_COL = C.ctx("environment_key", "The environment key the row belongs to.", "environment_key");

/** Parse a resource specifier (`proj/default:env/production:flag/dark-mode`). */
export function parseSpecifier(spec: unknown): { type: string; name: string }[] {
  if (typeof spec !== "string" || !spec) return [];
  return spec.split(":").map((seg) => {
    const i = seg.indexOf("/");
    const type = i < 0 ? seg : seg.slice(0, i);
    const name = i < 0 ? "" : (seg.slice(i + 1).split(";")[0] ?? "");
    return { type, name };
  });
}

const segName = (segs: { type: string; name: string }[], type: string) =>
  segs.find((s) => s.type === type)?.name ?? null;

/** The memberish display name: first + last, else null. */
const fullName = (m: Row | undefined): string | null => {
  if (!m) return null;
  const n = [m.firstName, m.lastName].filter((x) => typeof x === "string" && x).join(" ");
  return n || null;
};

// --------------------------------------------------------------------- projects

export const projects = defineLdCatalogTable(
  {
    name: "projects",
    description: "LaunchDarkly projects (keys, names, tags, client-side defaults)",
    title: "LaunchDarkly Projects",
    category: "structure",
    keywords: "launchdarkly, projects, workspaces, feature flags, tags",
    docLlm:
      "Every LaunchDarkly project (GET /api/v2/projects), one row each: id, key, name, tags, whether new flags are " +
      "available to client-side SDKs by default, and the default release pipeline. Project keys are the " +
      "`project_key` argument of every per-project function. WHERE key = / IN (...) pushes down as " +
      "`filter=keys:`; list_contains(tags, 'x') pushes down as `filter=tags:`.",
    docMd: "## projects\n\nOne row per LaunchDarkly project.",
    pushdown: "`key` (=, IN) → `filter=keys:a|b`; `list_contains(tags, …)` → `filter=tags:a+b`.",
    scope: "account",
    columns: [
      C.str("id", "Project id.", "_id"),
      C.str("key", "Project key (used in API paths and resource specifiers).", "key", false),
      C.str("name", "Project name.", "name"),
      C.strList("tags", "Project tags.", "tags"),
      C.bool(
        "client_side_using_environment_id",
        "New flags default to being available to client-side (browser) SDKs.",
        "defaultClientSideAvailability.usingEnvironmentId",
      ),
      C.bool(
        "client_side_using_mobile_key",
        "New flags default to being available to mobile SDKs.",
        "defaultClientSideAvailability.usingMobileKey",
      ),
      C.str(
        "default_release_pipeline_key",
        "Key of the project's default release pipeline.",
        "defaultReleasePipelineKey",
      ),
    ],
    request: (_s, { constraints }) => {
      const keys = eqValues(constraints, "key");
      const tags = containsValues(constraints, "tags").filter(plainValue);
      return {
        path: "/api/v2/projects",
        paging: "offset",
        limit: 100,
        query: {
          filter: colonFilter([
            keys?.length && keys.every(plainValue) ? `keys:${keys.join("|")}` : undefined,
            tags.length ? `tags:${tags.join("+")}` : undefined,
          ]),
        },
      };
    },
    examples: [
      { sql: `SELECT key, name, tags FROM ${Q}.projects ORDER BY key`, description: "Every project" },
      {
        sql: `SELECT key, name FROM ${Q}.projects WHERE list_contains(tags, 'web') ORDER BY key`,
        description: "Projects tagged web (the tag filter is sent to LaunchDarkly)",
      },
    ],
  },
  ["key"],
);

// ------------------------------------------------------------------ environments

export const environments = defineLdTable<{ project_key: string | null }>({
  name: "environments",
  description: "LaunchDarkly environments per project, without SDK or mobile keys",
  title: "LaunchDarkly Environments",
  category: "structure",
  keywords: "launchdarkly, environments, production, staging, approvals, critical, client-side id",
  docLlm:
    "Environments of each project (GET /api/v2/projects/{projectKey}/environments): key, name, colour, whether " +
    "it is critical, change-control settings (require_comments, confirm_changes) and flag approval settings " +
    "(approvals_required, min_approvals, can_review_own_request, approval_service). client_side_id is the " +
    "environment's public client-side ID; server-side SDK keys and mobile keys are never returned. " +
    "project_key := 'x' (or WHERE project_key = ...) reads one project; otherwise every project is read.",
  docMd: "## environments(project_key := NULL)\n\nOne row per environment of each project.",
  pushdown:
    "`project_key` (=, IN) picks the projects; `key` (single =) → `filter=query:`; `critical` → `filter=critical:`; " +
    "`list_contains(tags, …)` → `filter=tags:`.",
  scope: "project",
  columns: [
    PROJECT_COL,
    C.str("key", "Environment key.", "key", false),
    C.str("name", "Environment name.", "name"),
    C.str(
      "client_side_id",
      "The environment's client-side ID (public: embedded in browser SDK bundles). SDK and mobile keys are never exposed.",
      "_id",
    ),
    C.str("color", "UI colour (hex, no #).", "color"),
    C.bool("critical", "Whether the environment is marked critical.", "critical"),
    C.int("default_ttl", "Default PHP SDK cache TTL in minutes.", "defaultTtl"),
    C.bool("secure_mode", "Client-side secure mode (contexts cannot inspect each other's variations).", "secureMode"),
    C.bool("default_track_events", "Initial trackEvents value for new flags.", "defaultTrackEvents"),
    C.bool("require_comments", "Members must comment when changing flags and segments in the UI.", "requireComments"),
    C.bool("confirm_changes", "Members must confirm flag and segment changes in the UI.", "confirmChanges"),
    C.strList("tags", "Environment tags.", "tags"),
    C.bool("approvals_required", "Flag changes need an approval request.", "approvalSettings.required"),
    C.int("min_approvals", "Approvals needed before a change can be applied.", "approvalSettings.minNumApprovals"),
    C.bool(
      "can_review_own_request",
      "Requesters may approve their own requests.",
      "approvalSettings.canReviewOwnRequest",
    ),
    C.str("approval_service", "Approval service: launchdarkly or an external one.", "approvalSettings.serviceKind"),
    C.strList(
      "approval_required_tags",
      "Approvals are required only for flags with these tags (empty = all flags).",
      "approvalSettings.requiredApprovalTags",
    ),
  ],
  request: (s, { constraints }) => {
    const key = eqOne(constraints, "key");
    const critical = eqBool(constraints, "critical");
    const tags = containsValues(constraints, "tags").filter(plainValue);
    return {
      path: `/api/v2/projects/${enc(s.project_key)}/environments`,
      paging: "offset",
      limit: 100,
      query: {
        filter: colonFilter([
          key && plainValue(key) ? `query:${key}` : undefined,
          critical === undefined ? undefined : `critical:${critical}`,
          tags.length ? `tags:${tags.join("+")}` : undefined,
        ]),
      },
    };
  },
  examples: [
    {
      sql: `SELECT project_key, key, critical, approvals_required FROM ${Q}.environments() ORDER BY project_key, key`,
      description: "Every environment and its change controls",
    },
    {
      sql: `SELECT project_key, key FROM ${Q}.environments() WHERE critical AND NOT approvals_required ORDER BY ALL`,
      description: "Critical environments that do not require approvals",
    },
  ],
});

// ------------------------------------------------------------------------ flags

/** The per-environment config of a flag row (`environments[<env>]`). */
const envCfg = (r: Row): Row | undefined => r.environments?.[r.__ctx?.environment_key ?? ""];

const targetCount = (cfg: Row | undefined): number | null => {
  if (!cfg) return null;
  let n = 0;
  for (const t of [...(cfg.targets ?? []), ...(cfg.contextTargets ?? [])])
    n += Array.isArray(t.values) ? t.values.length : 0;
  return n;
};

const ROLLOUT_FIELDS = [
  { name: "variation", kind: "int" as const, get: "variation" },
  { name: "weight", kind: "int" as const, get: "weight" },
];

const flagState = (r: Row): string => (r.archived ? "archived" : r.deprecated ? "deprecated" : "live");

const FLAG_STATE_CHOICES = ["live", "deprecated", "archived"];
const FLAG_SORTS = ["creationDate", "-creationDate", "key", "-key", "name", "-name", "maintainerId", "-maintainerId"];

interface FlagArgs extends Record<string, unknown> {
  project_key: string | null;
  environment_key: string | null;
  query: string | null;
  evaluated_since_days: bigint | null;
  sort: string | null;
  page_size: bigint;
}

/** The `filter=` of a flags request from pushed constraints and arguments. */
export function flagFilter(
  cs: Constraint[],
  args: Partial<FlagArgs>,
  env: string,
  anchorMs: number,
): string | undefined {
  const parts: (string | undefined)[] = [];
  const key = eqOne(cs, "key") ?? eqOne(cs, "flag_key");
  const q = typeof args.query === "string" && args.query ? args.query : key;
  if (q && plainValue(q)) parts.push(`query:${q}`);
  const tags = containsValues(cs, "tags").filter(plainValue);
  if (tags.length) parts.push(`tags:${tags.join("+")}`);
  const state = eqOne(cs, "state");
  if (state && FLAG_STATE_CHOICES.includes(state)) parts.push(`state:${state}`);
  else if (eqBool(cs, "archived") === true) parts.push("state:archived");
  else if (eqBool(cs, "deprecated") === true) parts.push("state:deprecated");
  const temporary = eqBool(cs, "temporary");
  if (temporary !== undefined) parts.push(`type:${temporary ? "temporary" : "permanent"}`);
  const maintainer = eqOne(cs, "maintainer_id");
  if (maintainer && plainValue(maintainer)) parts.push(`maintainerId:${maintainer}`);
  const team = eqOne(cs, "maintainer_team_key");
  if (team && plainValue(team)) parts.push(`maintainerTeamKey:${team}`);
  if (eqBool(cs, "client_side_using_environment_id") === true) parts.push("sdkAvailability:client");
  else if (eqBool(cs, "client_side_using_mobile_key") === true) parts.push("sdkAvailability:mobile");
  const { before } = timeBounds(cs, "creation_date");
  if (before !== undefined) parts.push(`creationDate:${JSON.stringify({ before })}`);
  if (args.evaluated_since_days != null) {
    const after = anchorMs - Number(args.evaluated_since_days) * DAY_MS;
    parts.push(`evaluated:${JSON.stringify({ after })}`, `filterEnv:${env}`);
  }
  return colonFilter(parts);
}

const flagRequest = (
  s: Scope,
  { args, constraints, anchorMs }: { args: Partial<FlagArgs>; constraints: Constraint[]; anchorMs: number },
) => ({
  path: `/api/v2/flags/${enc(s.project_key)}`,
  paging: "offset" as const,
  limit: pageSize(args.page_size, 100),
  query: {
    env: s.environment_key,
    summary: "0",
    filter: flagFilter(constraints, args, s.environment_key, anchorMs),
    sort: args.sort ?? undefined,
  } as Record<string, QueryValue>,
});

const FLAG_ARGS = {
  query: utf8(),
  evaluated_since_days: int64(),
  sort: utf8(),
  page_size: int64(),
};
const FLAG_ARG_DOCS = {
  query: "Substring matched against flag keys and names, case-insensitively (LaunchDarkly `filter=query:`).",
  evaluated_since_days:
    "Only flags evaluated in this environment within the last N days (LaunchDarkly `filter=evaluated:` + `filterEnv`).",
  sort: "LaunchDarkly sort field: creationDate, key, name or maintainerId; prefix - for descending.",
  page_size: PAGE_SIZE_DOC,
};
const FLAG_ARG_DEFAULTS = { query: null, evaluated_since_days: null, sort: null, page_size: 100 };
const FLAG_ARG_CONSTRAINTS = {
  page_size: { ge: 1, le: 100 },
  evaluated_since_days: { ge: 1 },
  sort: { choices: FLAG_SORTS },
};

export const flags = defineLdTable<FlagArgs>({
  name: "flags",
  description: "Feature flags with their per-environment targeting state, one row per flag and environment",
  title: "LaunchDarkly Feature Flags",
  category: "flags",
  keywords:
    "launchdarkly, feature flags, toggles, targeting, variations, rollout, fallthrough, prerequisites, temporary, stale flags",
  docLlm:
    "Feature flags of each project (GET /api/v2/flags/{projectKey}?env=<env>&summary=0), one row per flag and " +
    "environment. Flag-level columns: key, name, description, kind (boolean / multivariate), state (live / " +
    "deprecated / archived), temporary, tags, maintainer_id / maintainer_email / maintainer_team_key, " +
    "client-side availability, variations (index, id, name, value as text), default on/off variations, " +
    "creation_date. Environment columns: targeting_on, off_variation, fallthrough_variation or fallthrough_rollout " +
    "(weights in thousandths of a percent, 100000 = 100%), rule_count, target_count (individually targeted " +
    "contexts), prerequisites (key, variation), last_modified, env_version, site_url. Like the LaunchDarkly API, " +
    "archived flags are only returned when asked for: WHERE archived (or state = 'archived'). Arguments: " +
    "project_key / environment_key (NULL = all, or push WHERE project_key/environment_key = ...), query " +
    "(substring of key or name), evaluated_since_days, sort, page_size. Use flag_rules for the targeting rules " +
    "themselves and flag_status for evaluation activity.",
  docMd:
    "## flags(project_key := NULL, environment_key := NULL, query := NULL, evaluated_since_days := NULL, sort := NULL, page_size := 100)\n\n" +
    "One row per flag and environment, with the flag's targeting state in that environment.",
  pushdown:
    "`project_key`, `environment_key` (=, IN) pick the scopes; `key` (single =) → `filter=query:`; " +
    "`list_contains(tags, …)` → `filter=tags:a+b`; `state` / `archived` / `deprecated` → `filter=state:`; " +
    "`temporary` → `filter=type:`; `maintainer_id`, `maintainer_team_key` → `filter=maintainerId:` / " +
    "`maintainerTeamKey:`; `client_side_using_environment_id` / `client_side_using_mobile_key` = true → " +
    '`filter=sdkAvailability:`; `creation_date <` → `filter=creationDate:{"before":…}`.',
  scope: "env",
  args: FLAG_ARGS,
  argDocs: FLAG_ARG_DOCS,
  argDefaults: FLAG_ARG_DEFAULTS,
  argConstraints: FLAG_ARG_CONSTRAINTS,
  columns: [
    PROJECT_COL,
    ENV_COL,
    C.str("environment_name", "The environment's display name.", (r) => envCfg(r)?._environmentName),
    C.str("key", "Flag key (what code evaluates).", "key", false),
    C.str("name", "Flag name.", "name"),
    C.str("description", "Flag description.", "description"),
    C.str("kind", "boolean or multivariate.", "kind"),
    C.str("state", "live, deprecated or archived.", flagState),
    C.bool("temporary", "Temporary (release) flag rather than permanent.", "temporary"),
    C.bool("archived", "The flag is archived.", "archived"),
    C.bool("deprecated", "The flag is deprecated.", "deprecated"),
    C.strList("tags", "Flag tags.", "tags"),
    C.str("maintainer_id", "Member id of the flag maintainer.", "maintainerId"),
    C.str("maintainer_email", "Email of the flag maintainer (as returned by LaunchDarkly).", "_maintainer.email"),
    C.str("maintainer_team_key", "Key of the maintaining team.", "maintainerTeamKey"),
    C.bool(
      "client_side_using_environment_id",
      "Available to browser SDKs (client-side ID).",
      "clientSideAvailability.usingEnvironmentId",
    ),
    C.bool(
      "client_side_using_mobile_key",
      "Available to mobile SDKs (mobile key).",
      "clientSideAvailability.usingMobileKey",
    ),
    C.structList(
      "variations",
      "Variations: idx, id, name, description, value (JSON text for non-strings).",
      [
        { name: "idx", kind: "int", get: "#" },
        { name: "id", kind: "str", get: "_id" },
        { name: "name", kind: "str", get: "name" },
        { name: "description", kind: "str", get: "description" },
        { name: "value", kind: "text", get: "value" },
      ],
      "variations",
    ),
    C.int("default_on_variation", "Variation index new environments serve when on.", "defaults.onVariation"),
    C.int("default_off_variation", "Variation index new environments serve when off.", "defaults.offVariation"),
    C.ms("creation_date", "When the flag was created.", "creationDate"),
    C.ms("archived_date", "When the flag was archived.", "archivedDate"),
    C.ms("deprecated_date", "When the flag was deprecated.", "deprecatedDate"),
    C.int("flag_version", "Flag version (all environments).", "_version"),
    C.bool("ready_to_archive", "LaunchDarkly flags it stale: ready to archive.", "stale.readyToArchive"),
    C.bool("ready_for_code_removal", "LaunchDarkly flags it ready for code removal.", "stale.readyForCodeRemoval"),
    C.bool("targeting_on", "Targeting is on in this environment.", (r) => envCfg(r)?.on),
    C.int("off_variation", "Variation index served when targeting is off.", (r) => envCfg(r)?.offVariation),
    C.int(
      "fallthrough_variation",
      "Default-rule variation idx (NULL for a rollout).",
      (r) => envCfg(r)?.fallthrough?.variation,
    ),
    C.structList(
      "fallthrough_rollout",
      "Default-rule rollout: variation idx and weight (1/1000 %).",
      ROLLOUT_FIELDS,
      (r) => envCfg(r)?.fallthrough?.rollout?.variations,
    ),
    C.int(
      "rule_count",
      "Number of targeting rules in this environment.",
      (r) => envCfg(r)?.rules?.length ?? (envCfg(r) ? 0 : null),
    ),
    C.int("target_count", "Contexts targeted individually in this environment.", (r) => targetCount(envCfg(r))),
    C.structList(
      "prerequisites",
      "Prerequisite flags: key and required variation idx.",
      [
        { name: "key", kind: "str", get: "key" },
        { name: "variation", kind: "int", get: "variation" },
      ],
      (r) => envCfg(r)?.prerequisites ?? (envCfg(r) ? [] : null),
    ),
    C.bool("track_events", "Every evaluation sends a detailed event.", (r) => envCfg(r)?.trackEvents),
    C.ms("last_modified", "When the flag config in this environment last changed.", (r) => envCfg(r)?.lastModified),
    C.int("env_version", "Version of this environment's flag configuration.", (r) => envCfg(r)?.version),
    C.site("site_url", "LaunchDarkly UI link for this environment.", (r) => envCfg(r)?._site?.href),
    C.json("custom_properties", "Custom properties attached to the flag, as JSON.", "customProperties"),
  ],
  request: (s, ctx) => flagRequest(s, ctx),
  examples: [
    {
      sql: `SELECT key, targeting_on, rule_count, last_modified FROM ${Q}.flags(project_key := 'default', environment_key := 'production') ORDER BY last_modified DESC`,
      description: "Production flags, most recently changed first",
    },
    {
      sql: `SELECT environment_key, count(*) FILTER (WHERE targeting_on) AS flags_on, count(*) AS flags FROM ${Q}.flags(project_key := 'default') WHERE temporary GROUP BY ALL ORDER BY ALL`,
      description: "Temporary flags switched on per environment (temporary is sent as filter=type:temporary)",
    },
  ],
});

// ------------------------------------------------------------------- flag_rules

/** Flatten a page of flags into one row per (flag, rule, clause) in the scope's environment. */
export function flattenRules(rows: Row[], env: string): Row[] {
  const out: Row[] = [];
  for (const f of rows) {
    const cfg = f.environments?.[env];
    const rules: Row[] = Array.isArray(cfg?.rules) ? cfg.rules : [];
    rules.forEach((rule, ri) => {
      const base = { __flag: f, __rule: rule, __ri: ri };
      const clauses: Row[] = Array.isArray(rule.clauses) && rule.clauses.length ? rule.clauses : [{ __none: true }];
      clauses.forEach((cl, ci) => {
        out.push({ ...base, __clause: cl.__none ? null : cl, __ci: cl.__none ? null : ci });
      });
    });
  }
  return out;
}

export const flagRules = defineLdTable<FlagArgs>({
  name: "flag_rules",
  description: "Flag targeting rules and their clauses, one row per clause per flag and environment",
  title: "LaunchDarkly Flag Targeting Rules",
  category: "flags",
  keywords: "launchdarkly, targeting rules, clauses, segments, rollout, attributes, operators, feature flags",
  docLlm:
    "The targeting rules of every flag per environment, flattened: one row per (flag, environment, rule, clause) " +
    "with rule_index, rule_id, rule_description, rule_disabled, the served variation or rollout (weights in " +
    "thousandths of a percent), rollout_bucket_by / rollout_context_kind, and per clause clause_index, " +
    "context_kind, attribute, op (in, startsWith, segmentMatch, semVerGreaterThan, …), negate and clause_values " +
    "(JSON text for non-strings; segment keys for segmentMatch). A rule without clauses yields one row with " +
    "NULL clause columns. Same arguments and pushdown as flags (project_key, environment_key, query, " +
    "evaluated_since_days, sort, page_size); WHERE flag_key = 'x' sends filter=query:x.",
  docMd:
    "## flag_rules(project_key := NULL, environment_key := NULL, query := NULL, …)\n\n" +
    "One row per targeting-rule clause per flag and environment.",
  pushdown:
    "`project_key`, `environment_key` (=, IN) pick the scopes; `flag_key` (single =) → `filter=query:`; the flags " +
    "arguments pass through.",
  scope: "env",
  args: FLAG_ARGS,
  argDocs: FLAG_ARG_DOCS,
  argDefaults: FLAG_ARG_DEFAULTS,
  argConstraints: FLAG_ARG_CONSTRAINTS,
  columns: [
    PROJECT_COL,
    ENV_COL,
    C.str("flag_key", "Flag key.", "__flag.key", false),
    C.str("flag_name", "Flag name.", "__flag.name"),
    C.bool(
      "targeting_on",
      "Targeting is on for the flag in this environment.",
      (r) => at(r, `__flag.environments`) && r.__flag.environments[r.__ctx?.environment_key ?? ""]?.on,
    ),
    C.int("rule_index", "Position of the rule (0 = evaluated first).", "__ri"),
    C.str("rule_id", "Rule id.", "__rule._id"),
    C.str("rule_description", "Rule description.", "__rule.description"),
    C.bool("rule_disabled", "The rule is disabled.", (r) => r.__rule?.disabled ?? false),
    C.str("rule_ref", "Rule reference key, if set.", "__rule.ref"),
    C.int("variation", "Variation index the rule serves (NULL for a rollout).", "__rule.variation"),
    C.structList(
      "rollout",
      "Percentage rollout: variation index and weight (thousandths of a percent).",
      ROLLOUT_FIELDS,
      "__rule.rollout.variations",
    ),
    C.str("rollout_bucket_by", "Attribute the rollout buckets by.", "__rule.rollout.bucketBy"),
    C.str("rollout_context_kind", "Context kind the rollout buckets.", "__rule.rollout.contextKind"),
    C.bool("track_events", "Detailed events are sent for evaluations matching this rule.", "__rule.trackEvents"),
    C.int("clause_index", "Position of the clause in the rule (all clauses must match).", "__ci"),
    C.str("clause_id", "Clause id.", "__clause._id"),
    C.str("context_kind", "Context kind the clause tests (user, organization, …).", "__clause.contextKind"),
    C.str(
      "attribute",
      "Context attribute the clause tests (key, email, country, segmentMatch …).",
      "__clause.attribute",
    ),
    C.str(
      "op",
      "Operator: in, endsWith, startsWith, matches, contains, lessThan, before, segmentMatch, semVerEqual, …",
      "__clause.op",
    ),
    C.bool("negate", "The clause is negated.", "__clause.negate"),
    C.strList("clause_values", "Values the clause compares against (JSON text for non-strings).", "__clause.values"),
  ],
  request: (s, ctx) => flagRequest(s, ctx),
  expand: (rows, scope) => flattenRules(rows, scope.environment_key),
  examples: [
    {
      sql: `SELECT flag_key, rule_index, attribute, op, clause_values FROM ${Q}.flag_rules(project_key := 'default', environment_key := 'production') ORDER BY flag_key, rule_index, clause_index`,
      description: "Every production targeting clause",
    },
    {
      sql: `SELECT DISTINCT flag_key, unnest(clause_values) AS segment FROM ${Q}.flag_rules(project_key := 'default', environment_key := 'production') WHERE op = 'segmentMatch' ORDER BY ALL`,
      description: "Which segments each production flag targets",
    },
  ],
});

// ------------------------------------------------------------------ flag_status

export const flagStatus = defineLdTable<{ project_key: string | null; environment_key: string | null }>({
  name: "flag_status",
  description: "Flag evaluation status per environment: new, active, inactive or launched, and when last requested",
  title: "LaunchDarkly Flag Status",
  category: "flags",
  keywords: "launchdarkly, flag status, stale flags, inactive, launched, last requested, evaluations, cleanup",
  docLlm:
    "Evaluation status of every flag per environment (GET /api/v2/flag-statuses/{projectKey}/{environmentKey}): " +
    "status is new (never evaluated / created in the last 7 days), active (evaluated recently with changing " +
    "results), inactive (not evaluated for 7 days) or launched (serving one variation to everyone); " +
    "last_requested is when an SDK last evaluated it; default_value is the fallback value seen in code. Join to " +
    "flags on (project_key, environment_key, flag_key = key) for names and tags. Good for stale-flag cleanup.",
  docMd: "## flag_status(project_key := NULL, environment_key := NULL)\n\nOne row per flag per environment.",
  pushdown: "`project_key`, `environment_key` (=, IN) pick the scopes (the endpoint has no other filters).",
  scope: "env",
  columns: [
    PROJECT_COL,
    ENV_COL,
    C.str(
      "flag_key",
      "Flag key.",
      (r) =>
        typeof r._links?.parent?.href === "string" ? decodeURIComponent(r._links.parent.href.split("/").pop()) : null,
      false,
    ),
    C.str("status", "new, active, inactive or launched.", "name"),
    C.iso("last_requested", "When an SDK last evaluated the flag in this environment.", "lastRequested"),
    C.text("default_value", "The fallback value SDKs reported for the flag (JSON text for non-strings).", "default"),
  ],
  request: (s) => ({
    path: `/api/v2/flag-statuses/${enc(s.project_key)}/${enc(s.environment_key)}`,
    paging: "single",
  }),
  examples: [
    {
      sql: `SELECT flag_key, status, last_requested FROM ${Q}.flag_status(project_key := 'default', environment_key := 'production') WHERE status IN ('inactive', 'launched') ORDER BY flag_key`,
      description: "Production flags that are cleanup candidates",
    },
    {
      sql: `SELECT environment_key, status, count(*) AS flags FROM ${Q}.flag_status(project_key := 'default') GROUP BY ALL ORDER BY ALL`,
      description: "Flag status mix per environment",
    },
  ],
});

// --------------------------------------------------------------------- segments

const segCount = (keys: unknown, ctxs: unknown): number => {
  let n = Array.isArray(keys) ? keys.length : 0;
  if (Array.isArray(ctxs)) for (const c of ctxs) n += Array.isArray(c?.values) ? c.values.length : 0;
  return n;
};

const segKeys = (keys: unknown, ctxs: unknown): string[] => {
  const out: string[] = Array.isArray(keys) ? keys.map(String) : [];
  if (Array.isArray(ctxs)) for (const c of ctxs) if (Array.isArray(c?.values)) out.push(...c.values.map(String));
  return out;
};

export const segments = defineLdTable<{
  project_key: string | null;
  environment_key: string | null;
  query: string | null;
  include_members: boolean;
  page_size: bigint;
}>({
  name: "segments",
  description: "Segments per project and environment: rules and included/excluded counts",
  title: "LaunchDarkly Segments",
  category: "targeting",
  keywords: "launchdarkly, segments, audiences, big segments, synced segments, cohorts, targeting rules",
  docLlm:
    "Segments of each project and environment (GET /api/v2/segments/{projectKey}/{environmentKey}): key, name, " +
    "description, tags, unbounded (big segment), rule_count and rules (id, description, clause_count, weight, " +
    "bucket_by), included_count / excluded_count (individually listed targets), timestamps and version. Member " +
    "lists are not returned by default; include_members := true adds included_keys / excluded_keys. Arguments " +
    "project_key / environment_key (NULL = all), query (fuzzy key/name/description search), page_size.",
  docMd:
    "## segments(project_key := NULL, environment_key := NULL, query := NULL, include_members := false, page_size := 50)\n\n" +
    "One row per segment per environment.",
  pushdown:
    "`project_key`, `environment_key` (=, IN) pick the scopes; `key` (=, IN) → `filter=includedKeys anyOf [...]`; " +
    "`list_contains(tags, …)` → `filter=tags anyOf [...]`; `unbounded` → `filter=unbounded equals …`; " +
    '`query :=` → `filter=query equals "…"`.',
  scope: "env",
  args: { query: utf8(), include_members: bool, page_size: int64() },
  argDocs: {
    query: "Fuzzy search across segment key, name and description (LaunchDarkly `filter=query equals`).",
    include_members:
      "Also return the individually included/excluded target keys (included_keys / excluded_keys). Off by default.",
    page_size: PAGE_SIZE_DOC,
  },
  argDefaults: { query: null, include_members: false, page_size: 50 },
  argConstraints: { page_size: { ge: 1, le: 50 } },
  columns: [
    PROJECT_COL,
    ENV_COL,
    C.str("key", "Segment key.", "key", false),
    C.str("name", "Segment name.", "name"),
    C.str("description", "Segment description.", "description"),
    C.strList("tags", "Segment tags.", "tags"),
    C.bool("unbounded", "Big segment (list-based or synced) rather than a standard segment.", "unbounded"),
    C.str("unbounded_context_kind", "Context kind of a big segment.", "unboundedContextKind"),
    C.str("external", "External data store backing a synced segment.", "_external"),
    C.int("included_count", "Targets individually included (all context kinds).", (r) =>
      segCount(r.included, r.includedContexts),
    ),
    C.int("excluded_count", "Targets individually excluded (all context kinds).", (r) =>
      segCount(r.excluded, r.excludedContexts),
    ),
    C.strList("included_keys", "Included target keys (only with include_members := true).", (r) =>
      r.__members ? segKeys(r.included, r.includedContexts) : null,
    ),
    C.strList("excluded_keys", "Excluded target keys (only with include_members := true).", (r) =>
      r.__members ? segKeys(r.excluded, r.excludedContexts) : null,
    ),
    C.int("rule_count", "Number of segment rules.", (r) => (Array.isArray(r.rules) ? r.rules.length : null)),
    C.structList(
      "rules",
      "Segment rules: id, description, clause_count, weight (rollout, thousandths of a percent) and bucket_by.",
      [
        { name: "id", kind: "str", get: "_id" },
        { name: "description", kind: "str", get: "description" },
        { name: "clause_count", kind: "int", get: (x: Row) => (Array.isArray(x.clauses) ? x.clauses.length : 0) },
        { name: "weight", kind: "int", get: "weight" },
        { name: "bucket_by", kind: "str", get: "bucketBy" },
      ],
      "rules",
    ),
    C.json("rules_json", "The full segment rules with clauses, as JSON.", "rules"),
    C.ms("creation_date", "When the segment was created.", "creationDate"),
    C.ms("last_modified", "When the segment last changed.", "lastModifiedDate"),
    C.int("version", "Segment version.", "version"),
    C.bool("deleted", "The segment is deleted.", "deleted"),
  ],
  request: (s, { args, constraints }) => {
    const parts: string[] = [];
    if (args.query) parts.push(`query equals ${JSON.stringify(args.query)}`);
    const keys = eqValues(constraints, "key");
    if (keys?.length) parts.push(anyOf("includedKeys", keys));
    const tags = containsValues(constraints, "tags");
    if (tags.length) parts.push(anyOf("tags", tags));
    const unbounded = eqBool(constraints, "unbounded");
    if (unbounded !== undefined) parts.push(`unbounded equals ${unbounded}`);
    return {
      path: `/api/v2/segments/${enc(s.project_key)}/${enc(s.environment_key)}`,
      paging: "offset",
      limit: pageSize(args.page_size, 50),
      query: { filter: parts.length ? parts.join(",") : undefined },
    };
  },
  expand: (rows, _s, _cfg, { args }) => rows.map((r) => ({ ...r, __members: args.include_members === true })),
  examples: [
    {
      sql: `SELECT key, rule_count, included_count, excluded_count FROM ${Q}.segments(project_key := 'default', environment_key := 'production') ORDER BY key`,
      description: "Production segments and their sizes",
    },
    {
      sql: `SELECT environment_key, key FROM ${Q}.segments(project_key := 'default') WHERE unbounded ORDER BY ALL`,
      description: "Big segments in every environment (sent as filter=unbounded equals true)",
    },
  ],
});

// ---------------------------------------------------------------- context_kinds

export const contextKinds = defineLdTable<{ project_key: string | null }>({
  name: "context_kinds",
  description: "Context kinds defined in each project (user, organization, device …)",
  title: "LaunchDarkly Context Kinds",
  category: "targeting",
  keywords: "launchdarkly, context kinds, contexts, user, organization, device, multi-context",
  docLlm:
    "Context kinds of each project (GET /api/v2/projects/{projectKey}/context-kinds): key, name, description, " +
    "version, created_from, archived (hidden from targeting), creation_date, last_modified and last_seen (last " +
    "evaluation with that kind). project_key := 'x' reads one project; otherwise every project.",
  docMd: "## context_kinds(project_key := NULL)\n\nOne row per context kind per project.",
  pushdown: "`project_key` (=, IN) picks the projects.",
  scope: "project",
  columns: [
    PROJECT_COL,
    C.str("key", "Context kind key.", "key", false),
    C.str("name", "Context kind name.", "name"),
    C.str("description", "Description.", "description"),
    C.int("version", "Context kind version.", "version"),
    C.str("created_from", "How the kind was created (default, auto-add, manual).", "createdFrom"),
    C.bool("archived", "Archived (unavailable for targeting).", (r) => r.archived ?? r.hideInTargeting),
    C.ms("creation_date", "When the kind was created.", "creationDate"),
    C.ms("last_modified", "When the kind last changed.", "lastModified"),
    C.ms("last_seen", "When a context of this kind was last evaluated.", "lastSeen"),
  ],
  request: (s) => ({ path: `/api/v2/projects/${enc(s.project_key)}/context-kinds`, paging: "single" }),
  examples: [
    {
      sql: `SELECT project_key, key, last_seen FROM ${Q}.context_kinds() ORDER BY project_key, key`,
      description: "Context kinds and when each was last seen",
    },
  ],
});

// ---------------------------------------------------------------------- members

export const members = defineLdCatalogTable(
  {
    name: "members",
    description: "Account members: role, custom roles, teams, MFA and last seen",
    title: "LaunchDarkly Members",
    category: "access",
    keywords: "launchdarkly, members, users, roles, custom roles, teams, mfa, access review",
    docLlm:
      "Account members (GET /api/v2/members): id, email (as LaunchDarkly returns it), first/last name, base role " +
      "(reader, writer, admin, owner, no_access), custom_roles (keys), team_keys, mfa ('enabled' / 'disabled'), " +
      "pending_invite, verified, last_seen and creation_date. Use for access reviews; join custom_role_statements " +
      "on list_contains(custom_roles, role_key) to see what a member can do.",
    docMd: "## members\n\nOne row per account member.",
    pushdown:
      "`id`, `email` (=, IN) → `filter=id:a|b` / `email:a|b`; `role` (single =) → `filter=role:`; " +
      "`list_contains(team_keys, …)` → `filter=team:`.",
    scope: "account",
    columns: [
      C.str("id", "Member id.", "_id", false),
      C.str("email", "Member email.", "email"),
      C.str("first_name", "Given name as stored in LaunchDarkly.", "firstName"),
      C.str("last_name", "Family name as stored in LaunchDarkly.", "lastName"),
      C.str("role", "Base role: reader, writer, admin, owner or no_access.", "role"),
      C.strList("custom_roles", "Keys of additional custom roles.", "customRoles"),
      C.strList("team_keys", "Teams the member belongs to.", (r) =>
        Array.isArray(r.teams) ? r.teams.map((t: Row) => t.key) : null,
      ),
      C.str("mfa", "MFA state: enabled or disabled.", "mfa"),
      C.bool("pending_invite", "The member has not accepted their invitation.", "_pendingInvite"),
      C.bool("verified", "The member's email is verified.", "_verified"),
      C.ms("last_seen", "Last session (NULL if never).", "_lastSeen"),
      C.ms("creation_date", "When the member was created.", "creationDate"),
    ],
    request: (_s, { constraints }) => {
      const ids = eqValues(constraints, "id");
      const emails = eqValues(constraints, "email");
      const role = eqOne(constraints, "role");
      const teams = containsValues(constraints, "team_keys").filter(plainValue);
      return {
        path: "/api/v2/members",
        paging: "offset",
        limit: 100,
        query: {
          filter: colonFilter([
            ids?.length && ids.every(plainValue) ? `id:${ids.join("|")}` : undefined,
            emails?.length && emails.every(plainValue) ? `email:${emails.join("|")}` : undefined,
            role && plainValue(role) ? `role:${role}` : undefined,
            teams.length === 1 ? `team:${teams[0]}` : undefined,
          ]),
        },
      };
    },
    examples: [
      {
        sql: `SELECT role, count(*) AS members FROM ${Q}.members GROUP BY role ORDER BY members DESC`,
        description: "Members per base role",
      },
      {
        sql: `SELECT email, role FROM ${Q}.members WHERE role IN ('admin', 'owner') AND mfa <> 'enabled' ORDER BY email`,
        description: "Admins without MFA",
      },
    ],
  },
  ["id"],
);

// ------------------------------------------------------------------------ teams

export const teams = defineLdCatalogTable(
  {
    name: "teams",
    description: "Teams with member counts and custom roles",
    title: "LaunchDarkly Teams",
    category: "access",
    keywords: "launchdarkly, teams, groups, custom roles, maintainers, access",
    docLlm:
      "Teams (GET /api/v2/teams?expand=members,roles): key, name, description, member_count, custom_role_keys, " +
      "idp_synced (managed by SCIM / IdP), version, creation_date and last_modified.",
    docMd: "## teams\n\nOne row per team.",
    pushdown: "`key` (single =) → `filter=query:`.",
    scope: "account",
    columns: [
      C.str("key", "Team key.", "key", false),
      C.str("name", "Team name.", "name"),
      C.str("description", "Team description.", "description"),
      C.int("member_count", "Count of members on the team.", "members.totalCount"),
      C.strList("custom_role_keys", "Custom roles assigned to the team.", (r) =>
        Array.isArray(r.roles?.items) ? r.roles.items.map((x: Row) => x.key) : null,
      ),
      C.bool("idp_synced", "Synced from an identity provider.", "_idpSynced"),
      C.int("version", "Team version number (increments on each change).", "_version"),
      C.ms("creation_date", "When the team was created.", "_creationDate"),
      C.ms("last_modified", "When the team last changed.", "_lastModified"),
    ],
    request: (_s, { constraints }) => {
      const key = eqOne(constraints, "key");
      return {
        path: "/api/v2/teams",
        paging: "offset",
        limit: 100,
        query: { expand: "members,roles", filter: key && plainValue(key) ? `query:${key}` : undefined },
      };
    },
    examples: [
      {
        sql: `SELECT key, member_count, custom_role_keys FROM ${Q}.teams ORDER BY member_count DESC`,
        description: "Teams by size",
      },
    ],
  },
  ["key"],
);

// ----------------------------------------------------------------- custom roles

const STATEMENT_FIELDS = [
  { name: "idx", kind: "int" as const, get: "#" },
  { name: "effect", kind: "str" as const, get: "effect" },
  { name: "actions", kind: "strList" as const, get: "actions" },
  { name: "not_actions", kind: "strList" as const, get: "notActions" },
  { name: "resources", kind: "strList" as const, get: "resources" },
  { name: "not_resources", kind: "strList" as const, get: "notResources" },
];

const ROLE_COMMON = {
  scope: "account" as const,
  request: () => ({ path: "/api/v2/roles", paging: "offset" as const, limit: 100 }),
};

export const customRoles = defineLdCatalogTable(
  {
    name: "custom_roles",
    description: "Custom roles with their policy statements",
    title: "LaunchDarkly Custom Roles",
    category: "access",
    keywords: "launchdarkly, custom roles, policies, permissions, rbac, statements, resource specifiers",
    docLlm:
      "Custom roles (GET /api/v2/roles): key, name, description, base_permissions, resource_category, " +
      "statement_count, assigned_members / assigned_teams and policy (list of statements: idx, effect allow/deny, " +
      "actions, not_actions, resources, not_resources as resource specifiers like proj/*:env/production:flag/*). " +
      "custom_role_statements has the same statements one row each.",
    docMd: "## custom_roles\n\nOne row per custom role.",
    ...ROLE_COMMON,
    columns: [
      C.str("id", "Role id.", "_id"),
      C.str("key", "Role key.", "key", false),
      C.str("name", "Role name.", "name"),
      C.str("description", "Role description.", "description"),
      C.str("base_permissions", "Base permissions (reader or no_access).", "basePermissions"),
      C.str("resource_category", "Resource category the role manages.", "resourceCategory"),
      C.int("statement_count", "Number of policy statements.", (r) =>
        Array.isArray(r.policy) ? r.policy.length : null,
      ),
      C.int("assigned_members", "Count of members the role is assigned to.", "assignedTo.membersCount"),
      C.int("assigned_teams", "Count of teams the role is assigned to.", "assignedTo.teamsCount"),
      C.structList(
        "policy",
        "Policy statements in order: idx (0-based position), effect, actions, not_actions, resources, not_resources.",
        STATEMENT_FIELDS,
        "policy",
      ),
    ],
    examples: [
      {
        sql: `SELECT key, statement_count, assigned_members FROM ${Q}.custom_roles ORDER BY key`,
        description: "Custom roles and their use",
      },
    ],
  },
  ["key"],
);

export const customRoleStatements = defineLdCatalogTable(
  {
    name: "custom_role_statements",
    description: "Custom role policy statements, one row each",
    title: "Role Policy Statements",
    category: "access",
    keywords: "launchdarkly, custom roles, policy statements, permissions, allow, deny, actions, resources",
    docLlm:
      "Every policy statement of every custom role, one row each: role_key, role_name, statement_index, effect " +
      "(allow / deny), actions, not_actions, resources, not_resources. Resource specifiers look like " +
      "proj/*:env/production:flag/* ; actions like updateOn, updateRules, * . Find who can change production " +
      "flags by matching resources with LIKE '%env/production%' and joining members on custom_roles.",
    docMd: "## custom_role_statements\n\nOne row per policy statement.",
    ...ROLE_COMMON,
    columns: [
      C.str("role_key", "Custom role key.", "__role.key", false),
      C.str("role_name", "Custom role name.", "__role.name"),
      C.int("statement_index", "Position of the statement in the policy.", "__idx"),
      C.str("effect", "allow or deny.", "effect"),
      C.strList("actions", "Actions the statement covers.", "actions"),
      C.strList("not_actions", "Actions excluded (the statement covers all others).", "notActions"),
      C.strList("resources", "Resource specifiers the statement covers.", "resources"),
      C.strList("not_resources", "Resource specifiers excluded.", "notResources"),
    ],
    expand: (rows) =>
      rows.flatMap((role) =>
        (Array.isArray(role.policy) ? role.policy : []).map((st: Row, i: number) => ({
          ...st,
          __role: role,
          __idx: i,
        })),
      ),
    examples: [
      {
        sql: `SELECT role_key, effect, actions FROM ${Q}.custom_role_statements WHERE list_contains(resources, 'proj/*:env/production:flag/*') ORDER BY role_key, statement_index`,
        description: "Statements that apply to every production flag",
      },
    ],
  },
  ["role_key", "statement_index"],
);

// ----------------------------------------------------------- approval requests

export const approvalRequests = defineLdCatalogTable(
  {
    name: "approval_requests",
    description: "Approval requests for flag and segment changes, with review status",
    title: "LaunchDarkly Approval Requests",
    category: "changes",
    keywords: "launchdarkly, approvals, approval requests, change management, reviews, pending changes",
    docLlm:
      "Approval requests (GET /api/v2/approval-requests): id, description, requestor_id, review_status (pending / " +
      "approved / declined), status (pending / scheduled / failed / completed), resource_id (resource specifier) " +
      "parsed into project_key, environment_key, resource_kind (flag, segment, aiConfig) and resource_key, " +
      "notify_member_ids / notify_team_keys, reviews, instruction_kinds, creation_date, applied_date, " +
      "applied_by_member_id and execution_date (scheduled).",
    docMd: "## approval_requests\n\nOne row per approval request.",
    pushdown:
      "`review_status`, `status` (=, IN) → `filter=reviewStatus anyOf [...]` / `status anyOf [...]`; " +
      "`resource_kind`, `requestor_id`, `project_key`, `resource_id` (single =) → `filter=… equals …`.",
    scope: "account",
    columns: [
      C.str("id", "Approval request id.", "_id", false),
      C.str("description", "Request description.", "description"),
      C.str("requestor_id", "Member id of the requester.", "requestorId"),
      C.str("review_status", "pending, approved or declined.", "reviewStatus"),
      C.str("status", "pending, scheduled, failed or completed.", "status"),
      C.str("resource_id", "Resource specifier of the changed resource.", "resourceId"),
      C.str("project_key", "Project key parsed from resource_id.", (r) =>
        segName(parseSpecifier(r.resourceId), "proj"),
      ),
      C.str("environment_key", "Environment key parsed from resource_id.", (r) =>
        segName(parseSpecifier(r.resourceId), "env"),
      ),
      C.str(
        "resource_kind",
        "Kind of resource (flag, segment, aiConfig).",
        (r) => parseSpecifier(r.resourceId).at(-1)?.type ?? null,
      ),
      C.str("resource_key", "Key of the resource.", (r) => parseSpecifier(r.resourceId).at(-1)?.name ?? null),
      C.strList("notify_member_ids", "Members asked to review.", "notifyMemberIds"),
      C.strList("notify_team_keys", "Teams asked to review.", "notifyTeamKeys"),
      C.structList(
        "reviews",
        "Reviews: kind (approve / decline / comment), member_id and comment.",
        [
          { name: "kind", kind: "str", get: "kind" },
          { name: "member_id", kind: "str", get: "memberId" },
          { name: "comment", kind: "str", get: "comment" },
        ],
        "allReviews",
      ),
      C.strList("instruction_kinds", "Semantic-patch instruction kinds the request applies.", (r) =>
        Array.isArray(r.instructions) ? r.instructions.map((i: Row) => i.kind) : null,
      ),
      C.json("instructions", "The semantic-patch instructions, as JSON.", "instructions"),
      C.ms("creation_date", "When the request was created.", "creationDate"),
      C.ms("applied_date", "When the change was applied.", "appliedDate"),
      C.str("applied_by_member_id", "Member who applied the change.", "appliedByMemberId"),
      C.ms("execution_date", "When a scheduled change will execute.", "executionDate"),
      C.str("service_kind", "Approval service (launchdarkly or external).", "serviceKind"),
    ],
    request: (_s, { constraints }) => {
      const parts: string[] = [];
      const reviewStatus = eqValues(constraints, "review_status");
      if (reviewStatus?.length) parts.push(anyOf("reviewStatus", reviewStatus));
      const status = eqValues(constraints, "status");
      if (status?.length) parts.push(anyOf("status", status));
      for (const [col, f] of [
        ["resource_kind", "resourceKind"],
        ["requestor_id", "requestorId"],
        ["project_key", "projectKey"],
        ["resource_id", "resourceId"],
      ] as const) {
        const v = eqOne(constraints, col);
        if (v && !/[\s,]/.test(v)) parts.push(`${f} equals ${v}`);
      }
      return {
        path: "/api/v2/approval-requests",
        paging: "offset",
        limit: 200,
        query: { filter: parts.length ? parts.join(",") : undefined },
      };
    },
    examples: [
      {
        sql: `SELECT id, resource_key, environment_key, creation_date FROM ${Q}.approval_requests WHERE review_status = 'pending' ORDER BY creation_date`,
        description: "Pending approvals, oldest first (sent as filter=reviewStatus anyOf)",
      },
    ],
  },
  ["id"],
);

// ------------------------------------------------------------ scheduled changes

export const scheduledChanges = defineLdTable<{
  project_key: string | null;
  environment_key: string | null;
  flag_key: string | null;
}>({
  name: "scheduled_changes",
  description: "Scheduled flag changes per flag and environment",
  title: "LaunchDarkly Scheduled Changes",
  category: "changes",
  keywords: "launchdarkly, scheduled changes, scheduled flag changes, upcoming changes, release schedule",
  docLlm:
    "Scheduled changes of flags (GET /api/v2/projects/{p}/flags/{f}/environments/{e}/scheduled-changes): id, " +
    "execution_date, instruction_kinds (turnFlagOn, turnFlagOff, addRule, …), instructions JSON, maintainer_id, " +
    "creation_date, version, has_conflicts. The endpoint is per flag and environment: pass flag_key := 'x' " +
    "(or WHERE flag_key = / IN), or every live flag of the project is read (one call per flag and environment).",
  docMd:
    "## scheduled_changes(project_key := NULL, environment_key := NULL, flag_key := NULL)\n\n" +
    "One row per scheduled change.",
  pushdown: "`project_key`, `environment_key`, `flag_key` (=, IN) pick the flag/environment pairs read.",
  scope: "flag-env",
  notFoundEmpty: true,
  columns: [
    PROJECT_COL,
    ENV_COL,
    C.ctx("flag_key", "Flag key.", "flag_key"),
    C.str("id", "Scheduled change id.", "_id", false),
    C.ms("execution_date", "When the change will be applied.", "executionDate"),
    C.strList("instruction_kinds", "Instruction kinds to apply.", (r) =>
      Array.isArray(r.instructions) ? r.instructions.map((i: Row) => i.kind) : null,
    ),
    C.json("instructions", "The semantic-patch instructions, as JSON.", "instructions"),
    C.str("maintainer_id", "Member who maintains the scheduled change.", "_maintainerId"),
    C.ms("creation_date", "When it was created.", "_creationDate"),
    C.int("version", "Version.", "_version"),
    C.bool("has_conflicts", "LaunchDarkly reports conflicting scheduled changes.", (r) =>
      Array.isArray(r.conflicts) ? r.conflicts.length > 0 : r.conflicts != null && Object.keys(r.conflicts).length > 0,
    ),
  ],
  request: (s) => ({
    path: `/api/v2/projects/${enc(s.project_key)}/flags/${enc(s.flag_key)}/environments/${enc(s.environment_key)}/scheduled-changes`,
    paging: "single",
  }),
  examples: [
    {
      sql: `SELECT flag_key, environment_key, execution_date, instruction_kinds FROM ${Q}.scheduled_changes(project_key := 'default') ORDER BY execution_date`,
      description: "Upcoming scheduled flag changes",
    },
  ],
});

// ------------------------------------------------------------------ experiments

export const experiments = defineLdTable<{ project_key: string | null; lifecycle_state: string; page_size: bigint }>({
  name: "experiments",
  description: "Experiments across every environment of each project, with the current iteration",
  title: "LaunchDarkly Experiments",
  category: "experimentation",
  keywords: "launchdarkly, experiments, experimentation, a/b tests, iterations, treatments, metrics, hypothesis",
  docLlm:
    "Experiments of each project across environments (GET /api/v2/projects/{projectKey}/experiments?expand=treatments): " +
    "key, name, description, environment_key, maintainer_id, creation_date, archived_date, tags, type, " +
    "methodology, data_source, and the current iteration: iteration_status (not_started / running / stopped), " +
    "hypothesis, started_at, ended_at, randomization_unit, flag_keys, primary_metric_key, metric_keys, " +
    "treatments (name, allocation_percent, baseline), winning_treatment_id, winning_reason. lifecycle_state " +
    ":= 'active' (default), 'archived' or 'active,archived'.",
  docMd: "## experiments(project_key := NULL, lifecycle_state := 'active', page_size := 50)\n\nOne row per experiment.",
  pushdown:
    "`project_key` (=, IN) picks the projects; `iteration_status` (single =) → `filter=status:`; " +
    "`list_contains(flag_keys, …)` → `filter=flagKey:`; `primary_metric_key` (single =) → `filter=metricKey:`.",
  scope: "project",
  args: { lifecycle_state: utf8(), page_size: int64() },
  argDocs: {
    lifecycle_state: "Which experiments: active (default), archived, or active,archived for both.",
    page_size: PAGE_SIZE_DOC,
  },
  argDefaults: { lifecycle_state: "active", page_size: 50 },
  argConstraints: {
    lifecycle_state: { choices: ["active", "archived", "active,archived"] },
    page_size: { ge: 1, le: 50 },
  },
  columns: [
    PROJECT_COL,
    C.str("key", "Experiment key.", "key", false),
    C.str("id", "Experiment id.", "_id"),
    C.str("name", "Experiment name.", "name"),
    C.str("description", "Description.", "description"),
    C.str("environment_key", "Environment the experiment runs in.", "environmentKey"),
    C.str("maintainer_id", "Member who maintains it.", "_maintainerId"),
    C.ms("creation_date", "When it was created.", "_creationDate"),
    C.ms("archived_date", "When it was archived.", "archivedDate"),
    C.strList("tags", "Experiment tags.", "tags"),
    C.str("type", "Experiment type.", "type"),
    C.str("methodology", "bayesian, frequentist or export_only.", "methodology"),
    C.str("data_source", "Metric data source (launchdarkly, snowflake).", "dataSource"),
    C.str("iteration_id", "Current iteration id.", "currentIteration._id"),
    C.str("iteration_status", "Current iteration status: not_started, running or stopped.", "currentIteration.status"),
    C.str("hypothesis", "Current iteration hypothesis.", "currentIteration.hypothesis"),
    C.ms("started_at", "When the current iteration started.", "currentIteration.startedAt"),
    C.ms("ended_at", "When the current iteration ended.", "currentIteration.endedAt"),
    C.str("randomization_unit", "Randomization unit (context kind).", "currentIteration.randomizationUnit"),
    C.strList("flag_keys", "Flags the experiment uses.", (r) =>
      r.currentIteration?.flags && typeof r.currentIteration.flags === "object"
        ? Object.keys(r.currentIteration.flags)
        : null,
    ),
    C.str(
      "primary_metric_key",
      "Primary metric key.",
      (r) => r.currentIteration?.primarySingleMetric?.key ?? r.currentIteration?.primaryMetric?.key,
    ),
    C.strList("metric_keys", "Every metric of the current iteration.", (r) =>
      Array.isArray(r.currentIteration?.metrics) ? r.currentIteration.metrics.map((m: Row) => m.key) : null,
    ),
    C.structList(
      "treatments",
      "Treatments: name, allocation_percent and baseline.",
      [
        { name: "name", kind: "str", get: "name" },
        { name: "allocation_percent", kind: "str", get: "allocationPercent" },
        { name: "baseline", kind: "bool", get: "baseline" },
      ],
      "currentIteration.treatments",
    ),
    C.str(
      "winning_treatment_id",
      "Treatment chosen when the iteration stopped.",
      "currentIteration.winningTreatmentId",
    ),
    C.str("winning_reason", "Why the iteration was stopped.", "currentIteration.winningReason"),
  ],
  request: (s, { args, constraints }) => {
    const status = eqOne(constraints, "iteration_status");
    const flagKeys = containsValues(constraints, "flag_keys").filter(plainValue);
    const metric = eqOne(constraints, "primary_metric_key");
    return {
      path: `/api/v2/projects/${enc(s.project_key)}/experiments`,
      paging: "offset",
      limit: pageSize(args.page_size, 50),
      query: {
        expand: "treatments",
        lifecycleState: args.lifecycle_state,
        filter: colonFilter([
          status && plainValue(status) ? `status:${status}` : undefined,
          flagKeys.length === 1 ? `flagKey:${flagKeys[0]}` : undefined,
          metric && plainValue(metric) ? `metricKey:${metric}` : undefined,
        ]),
      },
    };
  },
  examples: [
    {
      sql: `SELECT key, environment_key, iteration_status, primary_metric_key FROM ${Q}.experiments(project_key := 'default') ORDER BY key`,
      description: "Experiments and what they measure",
    },
    {
      sql: `SELECT key, started_at FROM ${Q}.experiments() WHERE iteration_status = 'running' ORDER BY started_at`,
      description: "Running experiments in every project (sent as filter=status:running)",
    },
  ],
});

// ---------------------------------------------------------------------- metrics

export const metrics = defineLdTable<{ project_key: string | null; page_size: bigint }>({
  name: "metrics",
  description: "Metric definitions per project (custom, page view, click)",
  title: "LaunchDarkly Metrics",
  category: "experimentation",
  keywords: "launchdarkly, metrics, events, conversion, numeric metrics, experimentation, guarded rollouts",
  docLlm:
    "Metric definitions of each project (GET /api/v2/metrics/{projectKey}): key, name, description, kind " +
    "(custom / pageview / click / trace), event_key, is_numeric, unit, success_criteria, " +
    "unit_aggregation_type, analysis_type, percentile_value, analysis_units, category, tags, maintainer_id, " +
    "data_source_key, attached_flag_count, experiment_count, creation_date, last_seen and archived.",
  docMd: "## metrics(project_key := NULL, page_size := 50)\n\nOne row per metric.",
  pushdown:
    "`project_key` (=, IN) picks the projects; `key` (single =) → `filter=query equals`; `kind` (custom / pageview " +
    "/ click) → `filter=eventKind equals`; `is_numeric` → `filter=isNumeric equals`; `list_contains(tags, …)` → " +
    "`filter=tags contains [...]`.",
  scope: "project",
  args: { page_size: int64() },
  argDocs: { page_size: PAGE_SIZE_DOC },
  argDefaults: { page_size: 50 },
  argConstraints: { page_size: { ge: 1, le: 50 } },
  columns: [
    PROJECT_COL,
    C.str("key", "Metric key.", "key", false),
    C.str("id", "Metric id.", "_id"),
    C.str("version_id", "Metric version id.", "_versionId"),
    C.str("name", "Metric name.", "name"),
    C.str("description", "Description.", "description"),
    C.str("kind", "custom, pageview, click or trace.", "kind"),
    C.str("category", "Metric category.", "category"),
    C.str("event_key", "Event key sent by code (custom metrics).", "eventKey"),
    C.bool("is_numeric", "Tracks a numeric value rather than conversion.", "isNumeric"),
    C.str("unit", "Unit of a numeric metric.", "unit"),
    C.str("success_criteria", "HigherThanBaseline or LowerThanBaseline.", "successCriteria"),
    C.str("unit_aggregation_type", "average, sum or count_distinct.", "unitAggregationType"),
    C.str("analysis_type", "mean or percentile.", "analysisType"),
    C.int("percentile_value", "Target percentile for percentile analysis.", "percentileValue"),
    C.strList("analysis_units", "Context kinds allowed as analysis units.", "analysisUnits"),
    C.strList("tags", "Metric tags.", "tags"),
    C.str("maintainer_id", "Member who maintains the metric.", "maintainerId"),
    C.str("data_source_key", "Data source key.", "dataSource.key"),
    C.int("attached_flag_count", "Flags attached to the metric.", "_attachedFlagCount"),
    C.int("experiment_count", "Experiments using the metric.", "experimentCount"),
    C.ms("creation_date", "When it was created.", "_creationDate"),
    C.ms("last_seen", "Most recent data for the metric (hour fidelity).", "lastSeen"),
    C.bool("archived", "The metric version is archived.", "archived"),
  ],
  request: (s, { args, constraints }) => {
    const parts: string[] = [];
    const key = eqOne(constraints, "key");
    if (key) parts.push(`query equals ${JSON.stringify(key)}`);
    const kind = eqOne(constraints, "kind");
    if (kind && ["custom", "pageview", "click"].includes(kind)) parts.push(`eventKind equals ${kind}`);
    const numeric = eqBool(constraints, "is_numeric");
    if (numeric !== undefined) parts.push(`isNumeric equals ${numeric}`);
    const tags = containsValues(constraints, "tags");
    if (tags.length) parts.push(`tags contains [${tags.map((t) => JSON.stringify(t)).join(",")}]`);
    return {
      path: `/api/v2/metrics/${enc(s.project_key)}`,
      paging: "offset",
      limit: pageSize(args.page_size, 50),
      query: { filter: parts.length ? parts.join(",") : undefined },
    };
  },
  examples: [
    {
      sql: `SELECT key, kind, is_numeric, experiment_count FROM ${Q}.metrics(project_key := 'default') ORDER BY key`,
      description: "Metric definitions",
    },
  ],
});

// ------------------------------------------------------------ release pipelines

export const releasePipelines = defineLdTable<{ project_key: string | null }>({
  name: "release_pipelines",
  description: "Release pipelines per project with their phases",
  title: "LaunchDarkly Release Pipelines",
  category: "changes",
  keywords: "launchdarkly, release pipelines, phases, progressive delivery, release management",
  docLlm:
    "Release pipelines of each project (GET /api/v2/projects/{projectKey}/release-pipelines; LaunchDarkly marks " +
    "this API deprecated in favour of release policies but still serves it): key, name, description, tags, " +
    "is_project_default, is_legacy, version, created_at, phase_count and phases (idx, id, name, " +
    "environment_keys of the phase audiences).",
  docMd: "## release_pipelines(project_key := NULL)\n\nOne row per release pipeline.",
  pushdown: "`project_key` (=, IN) picks the projects; `key` (single =) → `filter=query:`.",
  scope: "project",
  columns: [
    PROJECT_COL,
    C.str("key", "Pipeline key.", "key", false),
    C.str("name", "Pipeline name.", "name"),
    C.str("description", "Description.", "description"),
    C.strList("tags", "Pipeline tags.", "tags"),
    C.bool("is_project_default", "The project's default pipeline.", "isProjectDefault"),
    C.bool("is_legacy", "A legacy pipeline.", "_isLegacy"),
    C.int("version", "Pipeline version.", "_version"),
    C.iso("created_at", "When it was created.", "createdAt"),
    C.int("phase_count", "Number of phases.", (r) => (Array.isArray(r.phases) ? r.phases.length : null)),
    C.structList(
      "phases",
      "Ordered phases: idx, id, name and the environment keys of their audiences.",
      [
        { name: "idx", kind: "int", get: "#" },
        { name: "id", kind: "str", get: "id" },
        { name: "name", kind: "str", get: "name" },
        {
          name: "environment_keys",
          kind: "strList",
          get: (p: Row) =>
            Array.isArray(p.audiences) ? p.audiences.map((a: Row) => a.environment?.key).filter(Boolean) : null,
        },
      ],
      "phases",
    ),
  ],
  request: (s, { constraints }) => {
    const key = eqOne(constraints, "key");
    return {
      path: `/api/v2/projects/${enc(s.project_key)}/release-pipelines`,
      paging: "offset",
      limit: 100,
      query: { filter: key && plainValue(key) ? `query:${key}` : undefined },
    };
  },
  examples: [
    {
      sql: `SELECT p.key, ph.name, ph.environment_keys FROM ${Q}.release_pipelines(project_key := 'default') p, unnest(p.phases) AS u(ph) ORDER BY p.key, ph.idx`,
      description: "Pipeline phases in order with their environments",
    },
  ],
});

// ----------------------------------------------------------- code references

export const codeRefRepositories = defineLdCatalogTable(
  {
    name: "code_ref_repositories",
    description: "Repositories scanned for flag code references (ld-find-code-refs)",
    title: "Code Reference Repos",
    category: "code",
    keywords: "launchdarkly, code references, repositories, ld-find-code-refs, github, gitlab, branches",
    docLlm:
      "Repositories connected to LaunchDarkly code references (GET /api/v2/code-refs/repositories?withBranches=1): " +
      "name, type (github, gitlab, bitbucket, custom), source_link, default_branch, enabled, version, " +
      "branch_count, branches (names) and last_synced (latest branch scan). Use code_references for the " +
      "individual flag references.",
    docMd: "## code_ref_repositories\n\nOne row per repository.",
    scope: "account",
    columns: [
      C.str("name", "Repository name.", "name", false),
      C.str("type", "github, gitlab, bitbucket or custom.", "type"),
      C.str("source_link", "URL of the repository.", "sourceLink"),
      C.str("default_branch", "Branch whose references code_references reports.", "defaultBranch"),
      C.bool("enabled", "Code reference scanning is enabled.", "enabled"),
      C.int("version", "Version number of the saved repository data (increments on each sync).", "version"),
      C.int("branch_count", "Count of branches scanned for references.", (r) =>
        Array.isArray(r.branches) ? r.branches.length : null,
      ),
      C.strList("branches", "Names of the scanned branches.", (r) =>
        Array.isArray(r.branches) ? r.branches.map((b: Row) => b.name) : null,
      ),
      C.ms("last_synced", "When a branch was last scanned.", (r) =>
        Array.isArray(r.branches) && r.branches.length
          ? Math.max(...r.branches.map((b: Row) => Number(b.syncTime) || 0))
          : null,
      ),
    ],
    request: () => ({ path: "/api/v2/code-refs/repositories", paging: "single", query: { withBranches: "1" } }),
    examples: [
      {
        sql: `SELECT name, type, default_branch, last_synced FROM ${Q}.code_ref_repositories ORDER BY name`,
        description: "Scanned repositories",
      },
    ],
  },
  ["name"],
);

export const codeReferences = defineLdTable<{ project_key: string | null; flag_key: string | null }>({
  name: "code_references",
  description: "Flag references found in code on each repository's default branch, one row per hunk",
  title: "LaunchDarkly Code References",
  category: "code",
  keywords: "launchdarkly, code references, flag usage, stale flags, cleanup, source code, hunks",
  docLlm:
    "Flag code references on each repository's default branch (GET /api/v2/code-refs/repositories?" +
    "withReferencesForDefaultBranch=1), one row per reference hunk: repository, repository_type, branch, head " +
    "(commit), sync_time, path, language_hint, starting_line, project_key, flag_key, aliases and lines (the " +
    "code snippet). project_key := / flag_key := (or WHERE project_key / flag_key =) narrow it server-side. " +
    "Flags with no rows here are candidates for archiving.",
  docMd: "## code_references(project_key := NULL, flag_key := NULL)\n\nOne row per code reference hunk.",
  pushdown: "`project_key` → `projKey`, `flag_key` → `flagKey` (single =, or the named arguments).",
  scope: "account",
  args: { project_key: utf8(), flag_key: utf8() },
  argDocs: {
    project_key: "Only references to flags of this project (LaunchDarkly `projKey`).",
    flag_key: "Only references to this flag (LaunchDarkly `flagKey`).",
  },
  argDefaults: { project_key: null, flag_key: null },
  columns: [
    C.str("repository", "Repository name.", "__repo.name", false),
    C.str("repository_type", "github, gitlab, bitbucket or custom.", "__repo.type"),
    C.str("branch", "Branch name.", "__branch.name"),
    C.str("head", "Commit the branch was scanned at.", "__branch.head"),
    C.ms("sync_time", "When the branch was scanned.", "__branch.syncTime"),
    C.str("path", "File path.", "__ref.path"),
    C.str("language_hint", "Language of the file.", "__ref.hint"),
    C.int("starting_line", "First line of the hunk.", "startingLineNumber"),
    C.str("project_key", "Project of the referenced flag.", "projKey"),
    C.str("flag_key", "Referenced flag key.", "flagKey"),
    C.strList("aliases", "Flag key aliases matched.", "aliases"),
    C.str("lines", "The code around the reference.", "lines"),
  ],
  request: (_s, { args, constraints }) => ({
    path: "/api/v2/code-refs/repositories",
    paging: "single",
    query: {
      withReferencesForDefaultBranch: "1",
      projKey: args.project_key ?? eqOne(constraints, "project_key"),
      flagKey: args.flag_key ?? eqOne(constraints, "flag_key"),
    },
  }),
  expand: (rows, _s, _c, { args, constraints }) => {
    const proj = args.project_key ?? eqOne(constraints, "project_key");
    const flag = args.flag_key ?? eqOne(constraints, "flag_key");
    const out: Row[] = [];
    for (const repo of rows) {
      for (const branch of Array.isArray(repo.branches) ? repo.branches : []) {
        for (const ref of Array.isArray(branch.references) ? branch.references : []) {
          for (const hunk of Array.isArray(ref.hunks) ? ref.hunks : []) {
            // The named arguments are filters too: keep their meaning exact.
            if (args.project_key && hunk.projKey !== proj) continue;
            if (args.flag_key && hunk.flagKey !== flag) continue;
            out.push({ ...hunk, __repo: repo, __branch: branch, __ref: ref });
          }
        }
      }
    }
    return out;
  },
  examples: [
    {
      sql: `SELECT flag_key, count(*) AS refs, count(DISTINCT repository) AS repos FROM ${Q}.code_references(project_key := 'default') GROUP BY flag_key ORDER BY refs DESC`,
      description: "How widely each flag is referenced in code",
    },
  ],
});

// -------------------------------------------------------------------- audit log

const ENV_SCOPED_KINDS = new Set(["flag", "segment", "experiment", "holdout", "destination"]);
const PROJECT_SCOPED_KINDS = new Set([
  "metric",
  "metric-group",
  "release-pipeline",
  "context-kind",
  "layer",
  "ai-config",
  "view",
]);
const ACCOUNT_KINDS = new Set([
  "member",
  "role",
  "team",
  "integration",
  "webhook",
  "relay-proxy-config",
  "service-token",
  "code-reference-repository",
  "application",
]);

/** A specifier-safe name, else the `*` wildcard (the SDK re-applies the exact filter). */
const specPart = (v: string | undefined): string => (v && /^[\w.\-@]+$/.test(v) ? v : "*");

/**
 * The audit log `spec` (resource specifier) implied by pushed filters on resource_kind,
 * project_key, environment_key and resource_key. Only a single known resource_kind
 * pushes; anything else lists every entry and the SDK filters.
 */
export function auditSpec(cs: Constraint[]): string | undefined {
  const kind = eqOne(cs, "resource_kind");
  if (!kind) return undefined;
  const p = specPart(eqOne(cs, "project_key"));
  const e = specPart(eqOne(cs, "environment_key"));
  const k = specPart(eqOne(cs, "resource_key"));
  if (ENV_SCOPED_KINDS.has(kind)) return `proj/${p}:env/${e}:${kind}/${k}`;
  if (PROJECT_SCOPED_KINDS.has(kind)) return `proj/${p}:${kind}/${k}`;
  if (kind === "environment") return `proj/${p}:env/${k}`;
  if (kind === "project") return `proj/${k}`;
  if (ACCOUNT_KINDS.has(kind)) return `${kind}/${k}`;
  return undefined;
}

/** The first target resource of an entry, parsed. */
const targetSegs = (r: Row) => parseSpecifier(Array.isArray(r.target?.resources) ? r.target.resources[0] : undefined);

interface AuditArgs extends Record<string, unknown> {
  q: string | null;
  lookback_days: bigint | null;
  include_diff: boolean;
  page_size: bigint;
}

/** The audit log request window: pushed `date` bounds, else the lookback from the scan anchor. */
export function auditWindow(
  cs: Constraint[],
  args: Partial<AuditArgs>,
  anchorMs: number,
): { after?: number; before?: number } {
  const { after, before } = timeBounds(cs, "date");
  if (after !== undefined || args.lookback_days == null || Number(args.lookback_days) === 0) return { after, before };
  return { after: anchorMs - Number(args.lookback_days) * DAY_MS, before };
}

export const auditLog = defineLdTable<AuditArgs>({
  name: "audit_log",
  description: "The account audit log: who changed what, when — the record of every flag, segment and settings change",
  title: "LaunchDarkly Audit Log",
  category: "changes",
  keywords:
    "launchdarkly, audit log, change history, who changed, incident, flag changes, compliance, what changed before the incident",
  docLlm:
    "Audit log entries (GET /api/v2/auditlog), newest first: id, date, resource_kind (flag, segment, environment, " +
    "project, member, role, team, metric, experiment, …), resource_name, resource_key, project_key and " +
    'environment_key (parsed from the target resource specifier), title ("Ada turned on the flag Dark mode in ' +
    'Production"), title_verb, description and short_description (markdown change summary), comment, actor ' +
    "(member email, else token or app name), member_id / member_email / member_name, token_id / token_name / " +
    "service_token, app_name, actions, resources, parent_resource, related_flag_key. include_diff := true fetches " +
    "each entry's JSON patch (delta) and previous/current versions (one extra call per entry). Filter on date to " +
    "choose the window (pushed as after/before); without a lower bound the last lookback_days (default 30; 0 = " +
    "all history) are read. The key table for 'what changed in production before the incident'.",
  docMd:
    "## audit_log(q := NULL, lookback_days := 30, include_diff := false, page_size := 20)\n\n" +
    "Audit log entries, newest first, paged by the `before` cursor.",
  pushdown:
    "`date` ranges → `after` / `before` (epoch ms); `resource_kind` (single =, with `project_key`, " +
    "`environment_key`, `resource_key`) → `spec` resource specifier (e.g. `proj/default:env/production:flag/*`); " +
    "`member_id` (=, IN) → `member`; `token_id` (=, IN) → `token`; `q :=` → `q` full-text search.",
  scope: "account",
  args: { q: utf8(), lookback_days: int64(), include_diff: bool, page_size: int64() },
  argDocs: {
    q: "Full-text search over the audit log (LaunchDarkly `q`), e.g. a resource name.",
    lookback_days: "Days of history to read when no lower bound on date is given (0 = all history).",
    include_diff: "Fetch each entry's delta / previous_version / current_version (one extra call per entry).",
    page_size: "Entries per page (LaunchDarkly allows 1–20).",
  },
  argDefaults: { q: null, lookback_days: 30, include_diff: false, page_size: 20 },
  argConstraints: { lookback_days: { ge: 0 }, page_size: { ge: 1, le: 20 } },
  columns: [
    C.str("id", "Audit log entry id.", "_id", false),
    C.ms("date", "When the change happened.", "date"),
    C.str("resource_kind", "Kind of resource changed (flag, segment, environment, project, member, role, …).", "kind"),
    C.str("resource_name", "Name of the resource changed.", "name"),
    C.str(
      "resource_key",
      "Key of the resource (parsed from the target specifier).",
      (r) => targetSegs(r).at(-1)?.name ?? null,
    ),
    C.str("project_key", "Project of the resource (parsed from the target specifier).", (r) =>
      segName(targetSegs(r), "proj"),
    ),
    C.str("environment_key", "Environment of the resource (parsed from the target specifier).", (r) =>
      segName(targetSegs(r), "env"),
    ),
    C.str("title", "One-line summary: who did what to which resource.", "title"),
    C.str("title_verb", 'The action phrase ("turned on the flag").', "titleVerb"),
    C.str("description", "Markdown description of the change.", "description"),
    C.str("short_description", "Short description of the change.", "shortDescription"),
    C.str("comment", "Comment entered with the change.", "comment"),
    C.str(
      "actor",
      "Who made the change: member email, else token name, app name or subject name.",
      (r) => r.member?.email ?? r.token?.name ?? r.app?.name ?? r.subject?.name ?? null,
    ),
    C.str("member_id", "Member who made the change.", "member._id"),
    C.str("member_email", "Email of that member.", "member.email"),
    C.str("member_name", "Name of that member.", (r) => fullName(r.member)),
    C.str("token_id", "Access token that made the change.", "token._id"),
    C.str("token_name", "Name of that token.", "token.name"),
    C.bool("service_token", "The token is a service token.", "token.serviceToken"),
    C.str("app_name", "Authorized application that made the change.", "app.name"),
    C.strList("actions", "Actions performed (updateOn, updateRules, createFlag, …).", (r) =>
      Array.isArray(r.accesses) ? r.accesses.map((a: Row) => a.action) : null,
    ),
    C.strList("resources", "Target resource specifiers.", "target.resources"),
    C.str("parent_resource", "Parent resource specifier.", "parent.resource"),
    C.str("related_flag_key", "Flag updated as a side effect.", "relatedFlag.key"),
    C.json("delta", "JSON patch of the change (include_diff := true).", "__detail.delta"),
    C.json("previous_version", "The resource before the change (include_diff := true).", "__detail.previousVersion"),
    C.json("current_version", "The resource after the change (include_diff := true).", "__detail.currentVersion"),
  ],
  request: (_s, { args, constraints, anchorMs }) => {
    const { after, before } = auditWindow(constraints, args, anchorMs);
    return {
      path: "/api/v2/auditlog",
      paging: "before",
      limit: pageSize(args.page_size, 20),
      query: {
        after: after === undefined ? undefined : String(after),
        before: before === undefined ? undefined : String(before),
        q: args.q ?? undefined,
        spec: auditSpec(constraints),
        member: eqValues(constraints, "member_id"),
        token: eqValues(constraints, "token_id"),
      },
    };
  },
  expand: async (rows, _s, cfg: LdConfig, { args }) => {
    if (!args.include_diff) return rows;
    const out: Row[] = [];
    for (const r of rows) {
      const detail = await ldGet(cfg, `/api/v2/auditlog/${enc(String(r._id))}`);
      out.push({ ...r, __detail: detail });
    }
    return out;
  },
  examples: [
    {
      sql: `SELECT date, actor, title FROM ${Q}.audit_log() WHERE resource_kind = 'flag' AND environment_key = 'production' AND date BETWEEN TIMESTAMPTZ '2026-11-14 09:00:00+00' AND TIMESTAMPTZ '2026-11-14 12:00:00+00' ORDER BY date DESC`,
      description: "Production flag changes in the hour before an incident (pushed as spec + after/before)",
    },
    {
      sql: `SELECT actor, count(*) AS changes FROM ${Q}.audit_log(lookback_days := 7) GROUP BY actor ORDER BY changes DESC`,
      description: "Who changed the most in the last week",
    },
  ],
});

/** Every table function, in catalog order. */
export const FUNCTIONS: VgiFunction[] = [
  environments,
  flags,
  flagRules,
  flagStatus,
  segments,
  contextKinds,
  scheduledChanges,
  experiments,
  metrics,
  releasePipelines,
  codeReferences,
  auditLog,
];

/** Every catalog table. */
export const TABLES = [
  projects,
  members,
  teams,
  customRoles,
  customRoleStatements,
  approvalRequests,
  codeRefRepositories,
];
