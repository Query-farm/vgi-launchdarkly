// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import {
  API_VERSION,
  assertSameOrigin,
  buildUrl,
  configFromSecrets,
  DEFAULT_BASE_URL,
  type LdConfig,
  ldGet,
  normalizeBaseUrl,
  resetDelayMs,
} from "../src/ld/client.ts";
import { type Constraint, timeBounds } from "../src/ld/pushdown.ts";
import { auditSpec, auditWindow, flagFilter, flattenRules, parseSpecifier } from "../src/ld/resources.ts";
import { asMs, nextBefore } from "../src/ld/table.ts";

const ROOT = join(import.meta.dir, "..");
const eq = (column: string, value: unknown): Constraint => ({ kind: "cmp", column, op: "eq", value });

test("base_url: https required except for loopback fixtures; path dropped", () => {
  expect(normalizeBaseUrl("https://app.eu.launchdarkly.com/")).toBe("https://app.eu.launchdarkly.com");
  expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(() => normalizeBaseUrl("http://app.launchdarkly.com")).toThrow(/https/);
  expect(() => normalizeBaseUrl("not a url")).toThrow(/not a URL/);
});

test("configFromSecrets: needs a token; base_url defaults to the commercial instance", () => {
  expect(() => configFromSecrets({})).toThrow(/no launchdarkly secret/);
  expect(() => configFromSecrets({ s: { type: "launchdarkly" } })).toThrow(/ACCESS_TOKEN/);
  const cfg = configFromSecrets({ s: { type: "launchdarkly", access_token: " api-x " } });
  expect(cfg).toEqual({ baseUrl: DEFAULT_BASE_URL, token: "api-x" });
  const fed = configFromSecrets({
    s: { type: "launchdarkly", access_token: "t", base_url: "https://app.launchdarkly.us" },
  });
  expect(fed.baseUrl).toBe("https://app.launchdarkly.us");
});

test("assertSameOrigin: never sends the token to another host", () => {
  const cfg: LdConfig = { baseUrl: DEFAULT_BASE_URL, token: "t" };
  expect(() => assertSameOrigin(cfg, `${DEFAULT_BASE_URL}/api/v2/flags/x`)).not.toThrow();
  expect(() => assertSameOrigin(cfg, "https://evil.example.com/api/v2/flags/x")).toThrow(/refusing/);
});

test("buildUrl: arrays repeat a parameter; empty values are dropped", () => {
  const cfg: LdConfig = { baseUrl: "https://h", token: "t" };
  expect(buildUrl(cfg, "/a", { member: ["m1", "m2"], q: "", x: undefined, filter: "tags:a+b" })).toBe(
    "https://h/a?member=m1&member=m2&filter=tags%3Aa%2Bb",
  );
});

test("resetDelayMs: X-Ratelimit-Reset is epoch milliseconds; Retry-After is seconds", () => {
  expect(resetDelayMs(new Headers({ "X-Ratelimit-Reset": "10500" }), 10_000)).toBe(600);
  expect(resetDelayMs(new Headers({ "Retry-After": "2" }), 0)).toBe(2000);
  expect(resetDelayMs(new Headers(), 0)).toBeUndefined();
});

test("timeBounds: exclusive after/before; inclusive bounds and sub-ms literals widen", () => {
  const ms = 1_000_000;
  expect(timeBounds([{ kind: "cmp", column: "date", op: "ge", value: BigInt(ms) * 1000n }], "date")).toEqual({
    after: ms - 1,
    before: undefined,
  });
  expect(timeBounds([{ kind: "cmp", column: "date", op: "lt", value: BigInt(ms) * 1000n + 500n }], "date")).toEqual({
    after: undefined,
    before: ms + 1,
  });
  expect(timeBounds([eq("date", BigInt(ms) * 1000n)], "date")).toEqual({ after: ms - 1, before: ms + 1 });
});

test("flagFilter: pushed constraints become one field:value filter", () => {
  const cs: Constraint[] = [
    { kind: "contains", column: "tags", value: "ui" },
    { kind: "contains", column: "tags", value: "beta" },
    eq("temporary", true),
    eq("archived", true),
    eq("maintainer_team_key", "platform"),
    eq("client_side_using_mobile_key", true),
    { kind: "cmp", column: "creation_date", op: "lt", value: 5_000_000n },
  ];
  expect(flagFilter(cs, {}, "production", 0)).toBe(
    'tags:ui+beta,state:archived,type:temporary,maintainerTeamKey:platform,sdkAvailability:mobile,creationDate:{"before":5000}',
  );
  // query := wins over a key equality; evaluated needs filterEnv.
  expect(flagFilter([eq("key", "dark-mode")], { query: "dark", evaluated_since_days: 1n }, "staging", 86_400_000)).toBe(
    'query:dark,evaluated:{"after":0},filterEnv:staging',
  );
  // Values that would split the filter are not pushed (the SDK still filters).
  expect(flagFilter([eq("key", "a,b")], {}, "p", 0)).toBeUndefined();
  expect(flagFilter([], {}, "p", 0)).toBeUndefined();
});

test("parseSpecifier and auditSpec: resource specifiers from filters", () => {
  expect(parseSpecifier("proj/default;web:env/production:flag/dark-mode")).toEqual([
    { type: "proj", name: "default" },
    { type: "env", name: "production" },
    { type: "flag", name: "dark-mode" },
  ]);
  expect(auditSpec([eq("resource_kind", "flag"), eq("environment_key", "production")])).toBe(
    "proj/*:env/production:flag/*",
  );
  expect(auditSpec([eq("resource_kind", "segment"), eq("project_key", "default"), eq("resource_key", "beta")])).toBe(
    "proj/default:env/*:segment/beta",
  );
  expect(auditSpec([eq("resource_kind", "metric"), eq("resource_key", "x")])).toBe("proj/*:metric/x");
  expect(auditSpec([eq("resource_kind", "environment"), eq("resource_key", "production")])).toBe(
    "proj/*:env/production",
  );
  expect(auditSpec([eq("resource_kind", "project")])).toBe("proj/*");
  expect(auditSpec([eq("resource_kind", "member")])).toBe("member/*");
  expect(auditSpec([eq("resource_kind", "flag"), eq("resource_key", "a:b")])).toBe("proj/*:env/*:flag/*");
  expect(auditSpec([eq("resource_kind", "unknown-kind")])).toBeUndefined();
  expect(auditSpec([eq("project_key", "default")])).toBeUndefined();
});

test("auditWindow: pushed lower bound beats lookback; 0 = all history", () => {
  const day = 86_400_000;
  expect(auditWindow([], { lookback_days: 30n }, 100 * day)).toEqual({ after: 70 * day, before: undefined });
  expect(auditWindow([], { lookback_days: 0n }, 100 * day)).toEqual({ after: undefined, before: undefined });
  const cs: Constraint[] = [{ kind: "cmp", column: "date", op: "gt", value: BigInt(5 * day) * 1000n }];
  expect(auditWindow(cs, { lookback_days: 30n }, 100 * day)).toEqual({ after: 5 * day, before: undefined });
});

test("nextBefore: follows _links.next, stops without it", () => {
  const rows = [{ date: 30 }, { date: 20 }];
  expect(nextBefore({ _links: { next: { href: "/api/v2/auditlog?before=20&limit=2" } } }, rows, 2, "")).toBe("20");
  expect(nextBefore({ _links: { self: { href: "/x" } } }, rows, 2, "")).toBe("");
  expect(nextBefore(null, rows, 2, "")).toBe("20");
  expect(nextBefore(null, rows, 5, "")).toBe("");
  // A cursor that does not move would loop forever: stop.
  expect(nextBefore({ _links: { next: { href: "/x?before=20" } } }, rows, 2, "20")).toBe("");
});

test("flattenRules: one row per clause; a clause-less rule still yields a row", () => {
  const flag = {
    key: "f",
    environments: {
      production: {
        rules: [
          { _id: "r1", clauses: [{ attribute: "a" }, { attribute: "b" }] },
          { _id: "r2", clauses: [] },
        ],
      },
    },
  };
  const rows = flattenRules([flag], "production");
  expect(rows.map((r) => [r.__ri, r.__ci, r.__clause?.attribute ?? null])).toEqual([
    [0, 0, "a"],
    [0, 1, "b"],
    [1, null, null],
  ]);
  expect(flattenRules([flag], "staging")).toEqual([]);
});

test("asMs: UnixMillis → TIMESTAMPTZ microseconds; 0 means never", () => {
  expect(asMs(1_700_000_000_000)).toBe(1_700_000_000_000_000n);
  expect(asMs(0)).toBeNull();
  expect(asMs(undefined)).toBeNull();
});

describe("ldGet against a local server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let hits: { path: string; auth: string | null; version: string | null }[] = [];
  let mode = "ok";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        hits.push({
          path: url.pathname + url.search,
          auth: req.headers.get("Authorization"),
          version: req.headers.get("LD-API-Version"),
        });
        if (mode === "429-once" && hits.length === 1) {
          return Response.json(
            { code: "rate_limited", message: "slow down" },
            { status: 429, headers: { "X-Ratelimit-Reset": String(Date.now() + 200) } },
          );
        }
        if (mode === "404") return Response.json({ code: "not_found", message: "Unknown project" }, { status: 404 });
        return Response.json({ items: [{ key: "a" }] });
      },
    });
  });
  afterAll(() => server.stop(true));

  const cfg = (): LdConfig => ({ baseUrl: `http://127.0.0.1:${server.port}`, token: "api-tok" });

  test("raw token, pinned API version, encoded query", async () => {
    hits = [];
    mode = "ok";
    const body = await ldGet(cfg(), "/api/v2/flags/default", { env: "production", filter: "tags:a+b" });
    expect(body).toEqual({ items: [{ key: "a" }] });
    expect(hits[0]).toEqual({
      path: "/api/v2/flags/default?env=production&filter=tags%3Aa%2Bb",
      auth: "api-tok",
      version: API_VERSION,
    });
  });

  test("429 waits for X-Ratelimit-Reset, then succeeds", async () => {
    hits = [];
    mode = "429-once";
    await ldGet(cfg(), "/api/v2/x");
    expect(hits.length).toBe(2);
  });

  test("4xx is not retried and carries LaunchDarkly's code and message", async () => {
    hits = [];
    mode = "404";
    await expect(ldGet(cfg(), "/api/v2/projects/x")).rejects.toThrow(/HTTP 404: not_found - Unknown project/);
    expect(hits.length).toBe(1);
  });
});

describe("the worker subprocess", () => {
  let client: VgiClient;

  beforeAll(() => {
    client = new VgiClient(subprocessConnect([process.execPath, "run", join(ROOT, "src", "worker.ts")]));
  });
  afterAll(() => client?.close());

  // Fixture-backed results are covered end to end through DuckDB in test/sql (all
  // transports); here the worker must fail clearly when no launchdarkly secret is attached.
  test("a scan without a launchdarkly secret explains how to create one", async () => {
    const run = async () => {
      for await (const _ of client.tableFunctionRows({
        functionName: "flags",
        arguments: new Arguments([], new Map()),
        int64: "bigint",
      })) {
        // no rows expected
      }
    };
    await expect(run()).rejects.toThrow(/CREATE SECRET \(TYPE launchdarkly/);
  });
});
