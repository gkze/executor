import { Effect, Schema } from "effect";

/**
 * Why an item v1 itself can no longer run is skipped rather than blocking its import
 * (`notes/v1-import.md`, decisions 20 and 21). Every refusal either names one of these or blocks.
 *
 * Cloud persists these values in its import reports, so the set only grows: never rename or
 * remove one.
 *
 * - `local_server`: a local (stdio) MCP server the importing product cannot run as v1 did: v1
 *   Cloud never ran one. A product that runs local commands (`V1ImportProduct.localServers`)
 *   refuses only one whose command it cannot run as v1 did.
 * - `no_base_url`: an API with no absolute server or base URL, so v1 had no host to call.
 * - `not_http`: a base URL, GraphQL endpoint or MCP address that is not http(s); for a tool, an
 *   OpenAPI operation whose server is not http(s), such as `wss://`, as v1 sent only HTTP requests.
 * - `undefined_server_variable`: an API whose server URL uses a variable no server defines, which
 *   v1 never resolved; for a tool, one operation's server.
 * - `unreadable_spec`: v1's stored specification does not read as one.
 * - `removed_tool`: a tool v1 last listed before the organization revised its integration, which
 *   the revised specification no longer has; v1 drops it when it next lists the tools.
 * - `missing_client`: the connection's OAuth client no longer exists in v1.
 * - `undeclared_method`: the connection's sign-in method is not one its integration declares.
 * - `incomplete_credential`: the connection's saved credential lacks a value its method sends.
 * - `missing_credential`: v1's credential store no longer holds the connection's saved credential,
 *   or keeps it in a store the product's v1 could not read either (see `Unsupported.elsewhere`).
 * - `unmatched_rule`: a tool policy that matches no tool v1 lists. It still moves, for tools the
 *   server may list again, and is reported in `unmatchedRules`.
 */
export const V1StaleCategory = Schema.Literals([
  "local_server",
  "no_base_url",
  "not_http",
  "undefined_server_variable",
  "unreadable_spec",
  "removed_tool",
  "missing_client",
  "undeclared_method",
  "incomplete_credential",
  "missing_credential",
  "unmatched_rule",
]);
export type V1StaleCategory = typeof V1StaleCategory.Type;

/**
 * v1's credential store kept failing a read (an outage or rate limit). The secret may exist; the
 * item that needed it reports the failure instead of retrying its step.
 */
export class V1CredentialsUnavailable extends Schema.TaggedError<V1CredentialsUnavailable>()(
  "V1CredentialsUnavailable",
  {},
) {}

/**
 * Why the document at a specification URL could not be fetched. It never names the URL, which can
 * carry a key in its user, host, port, path or query.
 */
export class SpecificationUnavailable extends Schema.TaggedError<SpecificationUnavailable>()(
  "SpecificationUnavailable",
  { reason: Schema.String },
) {}

/**
 * An item that cannot be imported, with a reason the person reads. With `stale`, v1 cannot run it
 * either: it is skipped and reported, and does not block its import (decision 20). Without, the
 * item is refused as it is, and an import of the same rows refuses it again.
 */
export class ItemFailed extends Schema.TaggedError<ItemFailed>()("ItemFailed", {
  reason: Schema.String,
  /**
   * A saved credential v1's credential store did not return: `missing` when it no longer holds
   * it, `unavailable` when it kept failing to answer, which a later attempt may not.
   */
  credential: Schema.optional(Schema.Literals(["missing", "unavailable"])),
  stale: Schema.optional(V1StaleCategory),
  /** The service did not respond: the item moves when tried again. */
  outage: Schema.optional(Schema.Literal(true)),
}) {}

/** Refuse an item with a reason the person reads. */
export const itemFailed = (reason: string) => Effect.fail(new ItemFailed({ reason }));
