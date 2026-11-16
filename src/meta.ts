/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "launchdarkly";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-launchdarkly";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  { name: "structure", title: "Projects and Environments", description: "Projects and their environments." },
  {
    name: "flags",
    title: "Feature Flags",
    description: "Flags with per-environment targeting state, targeting rules and evaluation status.",
  },
  { name: "targeting", title: "Targeting", description: "Segments and context kinds used in targeting." },
  {
    name: "changes",
    title: "Change Management",
    description: "The audit log, approval requests, scheduled changes and release pipelines.",
  },
  { name: "access", title: "Access", description: "Members, teams, custom roles and their policy statements." },
  { name: "experimentation", title: "Experimentation", description: "Experiments and metric definitions." },
  {
    name: "code",
    title: "Code References",
    description: "Repositories scanned for flag usage and the references found.",
  },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [LaunchDarkly REST API](https://launchdarkly.com/docs/api) — the endpoints this worker reads\n" +
  "- [Feature flags API](https://launchdarkly.com/docs/api/feature-flags/get-feature-flags) — `filter`, `sort`, `env`, `summary`\n" +
  "- [Audit log API](https://launchdarkly.com/docs/api/audit-log/get-audit-log-entries) and [resource specifiers](https://launchdarkly.com/docs/home/account/roles/role-resources)\n" +
  "- [Rate limiting](https://launchdarkly.com/docs/api#rate-limiting) and [API versioning](https://launchdarkly.com/docs/api#versioning)\n" +
  "- [Access tokens](https://launchdarkly.com/docs/home/account/api) (personal and service tokens)";

export const CATALOG_COMMENT =
  "LaunchDarkly feature management as SQL: projects, environments, flags and their targeting, segments, the audit log, approvals, members and experiments, read-only from the LaunchDarkly REST API.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a LaunchDarkly account through the REST API v2. Reach for it to answer " +
  "feature-management questions: which flags are on in production and how they target, which flags are " +
  "stale or fully launched, what changed and who changed it before an incident (the audit log's date, " +
  "resource kind, environment and resource filters push down as the after/before window and the resource " +
  "specifier `spec`), what is waiting for approval or scheduled, who has access through which roles, and " +
  "how experiments and metrics are defined. Every object needs a `launchdarkly` DuckDB secret with " +
  "ACCESS_TOKEN (API access token or service token) and optional BASE_URL (EU: https://app.eu.launchdarkly.com, " +
  "Federal: https://app.launchdarkly.us). Account-wide collections are tables; per-project and " +
  "per-environment collections take project_key := / environment_key := named arguments or pushed WHERE " +
  "project_key / environment_key = ... filters, and otherwise read every project and environment. Flag " +
  "filters (tags, state, temporary, maintainer, client-side availability, creation date) push into " +
  "LaunchDarkly's filter= parameter and are re-checked exactly. SDK keys and mobile keys are never " +
  "returned. Upstream docs: https://launchdarkly.com/docs/api ; audit log " +
  "https://launchdarkly.com/docs/api/audit-log/get-audit-log-entries ; rate limits " +
  "https://launchdarkly.com/docs/api#rate-limiting .";

export const CATALOG_DOC_MD =
  "# LaunchDarkly\n\n" +
  "Query a LaunchDarkly account from DuckDB: feature flags and how they target each environment, " +
  "change management (the audit trail, approvals and scheduled changes), access control and " +
  "experimentation. Read-only.\n\n" +
  "Create a `launchdarkly` secret with an access token (`ACCESS_TOKEN`); set `BASE_URL` for the EU or Federal " +
  "instance. Filters are translated into LaunchDarkly's `filter=`, audit-log `spec` and time window, so only " +
  "matching rows cross the network; offset paging and rate-limit headers are handled for you.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "LaunchDarkly REST API v2 collections as SQL. Account-wide collections (projects, access control, " +
  "approvals, code-reference repositories) are tables; per-project and per-environment collections are " +
  "table functions with project_key := / environment_key := (NULL = all) and optional named arguments. " +
  "Flag and targeting-rule functions return one row per flag per environment. The audit log is " +
  "time-windowed: filter on date (default lookback 30 days). All objects need a `launchdarkly` secret.";

export const SCHEMA_COMMENT = "LaunchDarkly flags, targeting, change management, access and experiments, read-only.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "LaunchDarkly collections: projects and environments, flags and targeting, change management, access and " +
  "experimentation.\n\n" +
  "Account-wide collections are tables; per-project and per-environment collections are table functions that " +
  "take the project and environment keys as named arguments or pushed filters and otherwise read them all.\n\n" +
  "All objects need a `launchdarkly` secret; filters push down into LaunchDarkly's filter syntax.";

export const AGENT_TEST_TASKS = [
  { name: "project_keys", prompt: "List the keys of all LaunchDarkly projects." },
  { name: "prod_flags_on", prompt: "Which flags in the default project are switched on in production?" },
  { name: "temporary_flag_count", prompt: "How many temporary flags does the default project have?" },
  { name: "archived_flags", prompt: "Which flags in the default project are archived?" },
  {
    name: "segment_targeting_flags",
    prompt: "Which flags target the beta-testers segment in production in the default project?",
  },
  { name: "launched_flags", prompt: "Which flags in the default project have launched status in production?" },
  { name: "big_segments", prompt: "Which segments in default/production are big (unbounded) segments?" },
  { name: "critical_envs", prompt: "Which environments are marked critical, in which projects?" },
  { name: "admins", prompt: "List the email addresses of members with the admin or owner role." },
  { name: "pending_approvals", prompt: "How many approval requests are pending review?" },
  {
    name: "prod_changes_before_incident",
    prompt:
      "Who changed production flags in the default project between 2026-11-14 09:00 and 12:00 UTC, and what did they do?",
  },
  { name: "running_experiments", prompt: "Which experiments are currently running in the default project?" },
  { name: "flag_code_refs", prompt: "In which files is the dark-mode flag referenced in code?" },
  {
    name: "repo_branches",
    prompt: "Which code-reference repositories are scanned, and how many branches does each have?",
  },
  { name: "archived_context_kinds", prompt: "Which context kinds in the default project are archived?" },
  { name: "deny_statements", prompt: "Which custom roles contain a deny statement?" },
  { name: "unused_roles", prompt: "How many custom roles are assigned to at least one member?" },
  { name: "numeric_metrics", prompt: "Which metrics in the default project track a numeric value, and in what unit?" },
  {
    name: "pipeline_phases",
    prompt: "What are the phases of the standard release pipeline in the default project, in order?",
  },
  { name: "upcoming_changes", prompt: "Which flag changes are scheduled in the default project, and when?" },
  { name: "largest_team", prompt: "Which LaunchDarkly team has the most members?" },
];

/** Bind-only probes: each binds the function and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "flags_columns",
    description: "The flags() result columns (binds only; create a launchdarkly secret and drop LIMIT 0 for rows)",
    sql: "SELECT project_key, environment_key, key, targeting_on, rule_count FROM launchdarkly.main.flags() LIMIT 0",
  },
  {
    name: "audit_log_columns",
    description: "The audit_log() result columns (binds only; create a launchdarkly secret and drop LIMIT 0 for rows)",
    sql: "SELECT date, actor, resource_kind, title FROM launchdarkly.main.audit_log() LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "LaunchDarkly Feature Management",
  "vgi.subtitle":
    "LaunchDarkly flags, targeting, segments, audit log, approvals, members and experiments as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "launchdarkly, feature flags, feature management, toggles, targeting, segments, audit log, approvals, experiments, release management",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "LaunchDarkly REST API",
  domain: "feature-management",
  "vgi.keywords": keywordsArray(
    "launchdarkly, flags, environments, segments, audit log, approvals, members, experiments",
  ),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
