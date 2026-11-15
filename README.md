<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query LaunchDarkly Flags, Targeting, Segments and the Audit Log in DuckDB

> **vgi-launchdarkly** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-launchdarkly/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-launchdarkly/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

LaunchDarkly feature management as SQL, read-only, through the
[LaunchDarkly REST API v2](https://launchdarkly.com/docs/api): which flags are on where
and how they target, which are stale, what is waiting for approval or scheduled, who has
access, and — the one you reach for during an incident — what changed, and who changed it.

```sql
CREATE SECRET ld (TYPE launchdarkly, ACCESS_TOKEN 'api-…');

-- What changed on production flags in the hour before the incident?
-- (resource_kind + environment_key become the audit `spec`, date becomes after/before.)
SELECT date, actor, resource_key, title
FROM launchdarkly.main.audit_log()
WHERE resource_kind = 'flag' AND environment_key = 'production'
  AND date BETWEEN TIMESTAMPTZ '2026-11-14 09:00Z' AND TIMESTAMPTZ '2026-11-14 10:00Z'
ORDER BY date DESC;

-- Temporary flags that are fully launched in production and still referenced in code.
SELECT f.key, s.last_requested, count(r.path) AS code_refs
FROM launchdarkly.main.flags(project_key := 'default', environment_key := 'production') f
JOIN launchdarkly.main.flag_status(project_key := 'default', environment_key := 'production') s
  ON s.flag_key = f.key
LEFT JOIN launchdarkly.main.code_references(project_key := 'default') r ON r.flag_key = f.key
WHERE f.temporary AND s.status = 'launched'
GROUP BY ALL ORDER BY code_refs DESC;
```

## Functions and tables

All live in `launchdarkly.main`. Per-project and per-environment functions take
`project_key :=` / `environment_key :=` named arguments **or** pushed
`WHERE project_key = … / IN (…)` filters; with neither they list every project and
environment and read each in turn (one extra call each). Everything pushed down is
re-applied exactly by the SDK, so pushdown only ever narrows what crosses the network.

| Object | LaunchDarkly endpoint | What pushes down |
|---|---|---|
| `projects` (table) | `GET /api/v2/projects` | `key` (=, IN) → `filter=keys:`; `list_contains(tags, …)` → `filter=tags:` |
| `environments(project_key)` | `GET /api/v2/projects/{p}/environments` | `key` (=) → `filter=query:`; `critical` → `filter=critical:`; tags |
| `flags(project_key, environment_key, query, evaluated_since_days, sort, page_size)` | `GET /api/v2/flags/{p}?env={e}&summary=0` | `key` → `filter=query:`; `list_contains(tags, …)` → `tags:a+b`; `state` / `archived` / `deprecated` → `state:`; `temporary` → `type:`; `maintainer_id`, `maintainer_team_key`; `client_side_using_environment_id` / `…_mobile_key` → `sdkAvailability:`; `creation_date <` → `creationDate:{"before":…}`; `evaluated_since_days` → `evaluated:{"after":…},filterEnv:` |
| `flag_rules(…same as flags)` | same | same; one row per rule clause per flag and environment |
| `flag_status(project_key, environment_key)` | `GET /api/v2/flag-statuses/{p}/{e}` | the scopes |
| `segments(project_key, environment_key, query, include_members := false)` | `GET /api/v2/segments/{p}/{e}` | `key` (=, IN) → `includedKeys anyOf`; tags → `tags anyOf`; `unbounded` → `unbounded equals` |
| `context_kinds(project_key)` | `GET /api/v2/projects/{p}/context-kinds` | the scopes |
| `members` (table) | `GET /api/v2/members` | `id`, `email` (=, IN) → `filter=id:a\|b` / `email:`; `role` → `role:`; `list_contains(team_keys, …)` → `team:` |
| `teams` (table) | `GET /api/v2/teams?expand=members,roles` | `key` → `filter=query:` |
| `custom_roles`, `custom_role_statements` (tables) | `GET /api/v2/roles` | — |
| `approval_requests` (table) | `GET /api/v2/approval-requests` | `review_status`, `status` (=, IN) → `anyOf`; `resource_kind`, `requestor_id`, `project_key`, `resource_id` → `equals` |
| `scheduled_changes(project_key, environment_key, flag_key)` | `GET /api/v2/projects/{p}/flags/{f}/environments/{e}/scheduled-changes` | the scopes (without `flag_key`, every live flag × environment) |
| `experiments(project_key, lifecycle_state := 'active')` | `GET /api/v2/projects/{p}/experiments` | `iteration_status` → `status:`; `list_contains(flag_keys, …)` → `flagKey:`; `primary_metric_key` → `metricKey:` |
| `metrics(project_key)` | `GET /api/v2/metrics/{p}` | `key` → `query equals`; `kind` → `eventKind equals`; `is_numeric`; tags → `tags contains` |
| `release_pipelines(project_key)` | `GET /api/v2/projects/{p}/release-pipelines` | `key` → `filter=query:` |
| `code_ref_repositories` (table) | `GET /api/v2/code-refs/repositories?withBranches=1` | — |
| `code_references(project_key, flag_key)` | `…/repositories?withReferencesForDefaultBranch=1` | `project_key` → `projKey`, `flag_key` → `flagKey` |
| `audit_log(q, lookback_days := 30, include_diff := false, page_size := 20)` | `GET /api/v2/auditlog` | `date` ranges → `after` / `before`; `resource_kind` (+ `project_key`, `environment_key`, `resource_key`) → `spec` resource specifier such as `proj/*:env/production:flag/*`; `member_id` / `token_id` (=, IN) → repeated `member` / `token`; `q :=` → `q` |

Notes:

- `flags` and `flag_rules` return one row per flag **per environment**. Like the API,
  archived flags appear only when you ask for them (`WHERE archived` or `state = 'archived'`).
- `audit_log` without a lower bound on `date` reads the last `lookback_days` (default 30;
  `lookback_days := 0` reads all history). `include_diff := true` fetches each entry's
  JSON patch and previous/current versions (one extra call per entry).
- Secrets never leak: environment SDK keys and mobile keys are never read into a column.
  `client_side_id` is the environment's public client-side ID (it ships in browser bundles).
- Rollout weights are in thousandths of a percent (`100000` = 100%), as in LaunchDarkly.

## Authentication

Create one `launchdarkly` secret with an **API access token** or **service token**
(*Account settings → Authorization*; a reader role is enough). LaunchDarkly takes the raw
token in the `Authorization` header. `BASE_URL` selects the instance:

```sql
CREATE SECRET ld (TYPE launchdarkly, ACCESS_TOKEN 'api-…');                                         -- commercial
CREATE SECRET ld_eu (TYPE launchdarkly, ACCESS_TOKEN 'api-…', BASE_URL 'https://app.eu.launchdarkly.com');
CREATE SECRET ld_fed (TYPE launchdarkly, ACCESS_TOKEN 'api-…', BASE_URL 'https://app.launchdarkly.us');
```

`ACCESS_TOKEN` is a redacted secret field. It is read from the secret on every call and
never stored in scan state, so it never travels in HTTP continuation tokens, and it is
never sent to an origin other than `BASE_URL` (`https://` only, except `http://127.0.0.1`
/ `localhost` for local test servers).

## Versioning, paging and rate limits

Every request pins `LD-API-Version: 20240415`. None of the endpoints used is a beta
endpoint, so no `LD-API-Version: beta` header is ever sent. Each LaunchDarkly page
becomes one Arrow batch. The cursor — the resolved project/environment/flag scopes, the
current scope, and its `offset` (or the audit log's `before` timestamp) — lives in the
table function's serializable state, so long scans resume on any worker process over the
HTTP transport. `X-Ratelimit-Global-Remaining` / `X-Ratelimit-Route-Remaining` /
`X-Ratelimit-Reset` (epoch ms) are tracked: a 429 waits until the reset (or `Retry-After`,
up to 65 s), the worker pauses on its own when a bucket is about to run dry, and 5xx and
network errors retry with exponential backoff.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone --branch v0.1.0 https://github.com/Query-farm/vgi-launchdarkly.git && cd vgi-launchdarkly
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'launchdarkly' (TYPE vgi, LOCATION '/abs/path/to/vgi-launchdarkly/bin/vgi-launchdarkly-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'launchdarkly' (TYPE vgi, LOCATION '/abs/path/to/vgi-launchdarkly/bin/vgi-launchdarkly-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows; point
`LOCATION` at the downloaded binary. The same binary serves HTTP with `--http --port 8000`
(see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (filter/spec translation, paging, backoff)
make test-sql                  # test/sql/launchdarkly.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real LaunchDarkly account. `test/mock_api/server.py` is
a stdlib-only, strict replay server over a hand-built account
(`test/fixtures/launchdarkly-account.json`, generated by `test/fixtures/build_fixture.py`
from LaunchDarkly's documented response shapes). It checks the raw `Authorization`
token and the pinned `LD-API-Version`, rejects unknown query parameters, sort and expand
values, and evaluates the flags `filter=`, the operator filters of segments, approvals and
metrics, and the audit log's `after`/`before`/`q`/`member`/`spec` (resource specifiers
with wildcards), so pushdown really narrows the data. It returns SDK and mobile keys like
the real API (the tests check they never surface), pages with `limit`/`offset` and
`_links.next`, and answers a 429 and a 503 once each so the retry paths always run. The
SQL tests read its `/__requests` log to check exactly what was pushed down.

The metadata check runs with `execute: false` in CI: every object needs a `launchdarkly`
secret for a live account.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
