/**
 * LaunchDarkly REST API v2 client: authentication, API versioning, rate limits.
 *
 * - **Auth.** A `launchdarkly` DuckDB secret carries an ACCESS_TOKEN (a personal API
 *   access token or a service token; LaunchDarkly expects the raw token in the
 *   `Authorization` header, with no scheme) and an optional BASE_URL (default
 *   https://app.launchdarkly.com; https://app.eu.launchdarkly.com for the EU instance,
 *   https://app.launchdarkly.us for Federal, or a loopback fixture server). The token
 *   never enters table-function state and is never sent to another origin.
 * - **Versioning.** Every request pins `LD-API-Version: 20240415`, the current stable
 *   REST API version, so response shapes cannot change under the worker. None of the
 *   endpoints read here is a beta endpoint, so no `LD-API-Version: beta` is ever sent.
 * - **Rate limits.** LaunchDarkly answers with `X-Ratelimit-Global-Remaining`,
 *   `X-Ratelimit-Route-Remaining` and `X-Ratelimit-Reset` (epoch **milliseconds**). A
 *   429 waits until that reset (or `Retry-After` seconds), bounded; when a bucket is
 *   about to run dry the client pauses before the next call instead of burning a 429.
 *   5xx and network errors retry with exponential backoff.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "launchdarkly";
export const DEFAULT_BASE_URL = "https://app.launchdarkly.com";
export const API_VERSION = "20240415";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a rate-limit reset. */
export const MAX_RATE_WAIT_MS = 65_000;
const USER_AGENT = `vgi-launchdarkly-worker/${VERSION}`;

export class LdError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface LdConfig {
  baseUrl: string;
  token: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LdError(`launchdarkly secret: base_url '${raw}' is not a URL (expected e.g. ${DEFAULT_BASE_URL})`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new LdError(
      "launchdarkly secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  return url.origin;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `launchdarkly` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): LdConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new LdError(
      "no launchdarkly secret: run CREATE SECRET (TYPE launchdarkly, ACCESS_TOKEN 'api-…') " +
        "(add BASE_URL 'https://app.eu.launchdarkly.com' or 'https://app.launchdarkly.us' for the EU or Federal instance)",
    );
  }
  const token = str(s.access_token);
  if (!token) throw new LdError("launchdarkly secret: ACCESS_TOKEN is required (an API access token or service token)");
  return { baseUrl: normalizeBaseUrl(str(s.base_url) ?? DEFAULT_BASE_URL), token };
}

/** Refuse to send the token to an origin other than the configured instance. */
export function assertSameOrigin(cfg: LdConfig, url: string): void {
  if (new URL(url).origin !== new URL(cfg.baseUrl).origin) {
    throw new LdError(
      `refusing to follow a link to ${new URL(url).origin}: it is not the configured LaunchDarkly host`,
    );
  }
}

/** A query value: one value, a repeated parameter, or absent. */
export type QueryValue = string | string[] | undefined;

/** Build the request URL; repeated parameters (`env=a&env=b`) come from arrays. */
export function buildUrl(cfg: LdConfig, path: string, query?: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) if (x !== "") qs.append(k, x);
  }
  const q = qs.toString();
  return `${cfg.baseUrl}${path}${q ? `?${q}` : ""}`;
}

interface Bucket {
  remaining: number;
  resetMs: number;
}
/** Last rate-limit readings (module-level: one worker process, many scans). */
const buckets = new Map<string, Bucket>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait after a 429: until X-Ratelimit-Reset (epoch ms), else Retry-After seconds. */
export function resetDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const reset = headers.get("X-Ratelimit-Reset");
  if (reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) - now) + 100;
  const retry = headers.get("Retry-After");
  if (retry && /^\d+$/.test(retry)) return Number(retry) * 1000;
  return undefined;
}

function noteBuckets(origin: string, path: string, headers: Headers): void {
  const reset = headers.get("X-Ratelimit-Reset");
  if (!reset || !/^\d+$/.test(reset)) return;
  const resetMs = Number(reset);
  for (const [key, header] of [
    [origin, "X-Ratelimit-Global-Remaining"],
    [`${origin}${path}`, "X-Ratelimit-Route-Remaining"],
  ] as const) {
    const v = headers.get(header);
    if (v && /^\d+$/.test(v)) buckets.set(key, { remaining: Number(v), resetMs });
  }
}

async function waitForBuckets(origin: string, path: string): Promise<void> {
  for (const key of [origin, `${origin}${path}`]) {
    const b = buckets.get(key);
    if (b && b.remaining <= 1 && b.resetMs > Date.now()) {
      const wait = Math.min(b.resetMs - Date.now() + 100, MAX_RATE_WAIT_MS);
      log.info(`launchdarkly: rate-limit bucket nearly empty; waiting ${wait} ms for reset`);
      await sleep(wait);
    }
  }
}

/**
 * GET one LaunchDarkly resource and return its parsed JSON body. `path` is an API
 * path (`/api/v2/projects`); `query` values that are arrays repeat the parameter.
 */
export async function ldGet(cfg: LdConfig, path: string, query?: Record<string, QueryValue>): Promise<unknown> {
  const url = buildUrl(cfg, path, query);
  assertSameOrigin(cfg, url);
  const origin = new URL(cfg.baseUrl).origin;
  const route = new URL(url).pathname;

  for (let attempt = 1; ; attempt++) {
    await waitForBuckets(origin, route);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: cfg.token,
          "LD-API-Version": API_VERSION,
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new LdError(`GET ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    noteBuckets(origin, route, res.headers);
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new LdError(`GET ${redact(url)} failed with HTTP ${res.status}: ${await errorSummary(res)}`, res.status);
    }
    await res.body?.cancel();
    const delay =
      res.status === 429 ? Math.min(resetDelayMs(res.headers) ?? 1000 * attempt, MAX_RATE_WAIT_MS) : 250 * 2 ** attempt;
    log.debug(`launchdarkly: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** LaunchDarkly errors are `{code, message}`; keep the message short. */
async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { code?: string; message?: string };
    return [j.code, j.message].filter(Boolean).join(" - ") || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Show the path + query of a URL in errors (the token is a header, never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
