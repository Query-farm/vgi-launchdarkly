/**
 * Assemble the `launchdarkly` catalog: the table functions, the account-wide
 * collections as tables, and the `launchdarkly` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { SECRET_TYPE } from "./ld/client.ts";
import { FUNCTIONS, TABLES } from "./ld/resources.ts";
import { CATALOG_COMMENT, CATALOG_NAME, CATALOG_TAGS, SCHEMA_COMMENT, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";

export { FUNCTIONS };

const doc = (text: string) => new Map([["vgi_doc", text]]);

/** CREATE SECRET (TYPE launchdarkly, ACCESS_TOKEN 'api-…', BASE_URL '…'). */
export const LAUNCHDARKLY_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "A LaunchDarkly API access token or service token, plus the instance URL for EU / Federal accounts",
  schema: schema(
    [
      field(
        "access_token",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          ["vgi_doc", "LaunchDarkly API access token or service token (Account settings > Authorization), e.g. api-…"],
        ]),
      ),
      field(
        "base_url",
        utf8(),
        true,
        doc(
          "Instance URL: https://app.launchdarkly.com (default), https://app.eu.launchdarkly.com (EU) or " +
            "https://app.launchdarkly.us (Federal). http:// is accepted only for 127.0.0.1/localhost.",
        ),
      ),
    ],
    new Map([["vgi_doc_url", "https://launchdarkly.com/docs/home/account/api"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const ALL_EXAMPLES = [
  ...stampExampleQueries(FUNCTIONS),
  ...TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [LAUNCHDARKLY_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_COMMENT,
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
  ],
};
