# Changelog

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

Initial release: read-only LaunchDarkly REST API v2 worker — projects, environments, flags (per-environment targeting state), flag_rules, flag_status, segments, context_kinds, members, teams, custom_roles, custom_role_statements, approval_requests, scheduled_changes, experiments, metrics, release_pipelines, code_ref_repositories, code_references and audit_log, with filter pushdown and a strict offline replay server for tests.

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
