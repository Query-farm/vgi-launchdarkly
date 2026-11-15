/**
 * The worker entry point.
 *
 *   bin/vgi-launchdarkly-worker                      # stdio: what DuckDB launches by default
 *   bin/vgi-launchdarkly-worker --http --port 8000   # HTTP: for Docker / hosted deploys
 *   bin/vgi-launchdarkly-worker --help
 *
 * Attach it from DuckDB:
 *
 *   ATTACH 'launchdarkly' (TYPE vgi, LOCATION '/abs/path/to/bin/vgi-launchdarkly-worker');
 */

import { CATALOG } from "./catalog.ts";
import { serve } from "./cli.ts";
import { CATALOG_DOC_LLM, SOURCE_URL, VERSION } from "./meta.ts";

if (import.meta.main) {
  serve(CATALOG, { version: VERSION, doc: CATALOG_DOC_LLM, repositoryUrl: SOURCE_URL });
}
