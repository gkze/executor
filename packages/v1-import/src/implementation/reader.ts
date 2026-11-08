/**
 * What app generation and account decisions read from v1 beyond its rows (`V1Rows`). Each product
 * implements it over its own v1: Cloud over Postgres, WorkOS Vault and R2, a local import over
 * Executor 1's SQLite file and `auth.json`. `E` is the product's own failure for a read that may
 * succeed when tried again, such as its database being unavailable.
 */
import type { Effect, Option } from "effect";
import type { SpecificationUnavailable, V1CredentialsUnavailable } from "../contracts/index.ts";
import type { OpenApiOperationRow, ToolRow } from "./formats.ts";

export interface V1Reader<E> {
  /** The tools v1 last listed for an integration's org connections and these subjects' own. */
  readonly tools: (
    tenant: string,
    subjects: readonly [string, ...string[]],
    integration: string,
  ) => Effect.Effect<readonly ToolRow[], E>;
  /** The OpenAPI operations v1 compiled for an integration: tool name, method and path. */
  readonly openApiOperations: (
    tenant: string,
    integration: string,
  ) => Effect.Effect<readonly OpenApiOperationRow[], E>;
  /** The binding v1 stored for one OpenAPI tool of an integration, which v1 invokes. */
  readonly openApiBinding: (
    tenant: string,
    integration: string,
    tool: string,
  ) => Effect.Effect<unknown, E>;
  /** A plugin blob, such as an OpenAPI integration's stored specification (`spec/<hash>`). */
  readonly blob: (
    tenant: string,
    plugin: string,
    key: string,
  ) => Effect.Effect<Option.Option<Uint8Array>, E>;
  /** The item's failure reason when a blob is absent. */
  readonly blobMissing: string;
  /** The document at a URL v1 stored as a specification, fetched once as v1 fetched it. */
  readonly specification: (url: string) => Effect.Effect<Uint8Array, SpecificationUnavailable>;
  /**
   * A secret value from v1's credential store, as the subject reads it. Undefined when the store
   * does not hold it. The value never enters errors or logs.
   */
  readonly secret: (input: {
    readonly tenant: string;
    readonly subject: string;
    readonly itemId: string;
  }) => Effect.Effect<string | undefined, V1CredentialsUnavailable | E>;
}
