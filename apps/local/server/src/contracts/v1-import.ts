/**
 * `executor import-v1`: move an Executor 1 data directory's integrations, connections and tool
 * policies into this Executor. `--dry-run` reads Executor 1's files and writes nothing anywhere;
 * an import runs in the background Executor, which owns this Executor's data.
 */
import { RequestRejection } from "@executor-js/sdk/core";
import { ApiError } from "@executor-js/utils/api-error";
import { V1StaleCategory } from "@executor-js/v1-import/contracts";
import { Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

export const importV1Command = Command.make("import-v1", {
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Report what would move and why, writing nothing"),
    Flag.withDefault(false),
  ),
  from: Flag.Directory("from").pipe(
    Flag.withDescription("Executor 1's data directory. Default: ~/.executor"),
    Flag.optional,
  ),
  workspace: Flag.String("workspace").pipe(
    Flag.withDescription(
      "Only this Executor 1 workspace, such as .executor-068dc3bf. Default: every workspace",
    ),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the report as JSON"),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Move Executor 1's integrations, connections and tool policies into this Executor",
  ),
);

/**
 * What happens to one Executor 1 item, or would with `--dry-run`:
 *
 * - `moves`: it becomes an app, account or approval rule, with its saved credential.
 * - `reconnect`: it moves without its credential, which you connect again in this Executor.
 * - `cannot_move`: this Executor cannot take it as it is, such as a stdio MCP server run through
 *   Executor 1's Codex app-server adapter, or an app whose generated source does not build.
 *   Running the import again refuses it again, unless what the reason names changes.
 * - `skipped`: Executor 1 could not run it either, such as a connection whose credential is gone.
 * - `failed`: an import tried and something that may clear up stopped it, such as a service that
 *   did not respond; the reason says what. Running the import again tries it again.
 */
export const V1ImportOutcome = Schema.Literals([
  "moves",
  "reconnect",
  "cannot_move",
  "skipped",
  "failed",
]);
export type V1ImportOutcome = typeof V1ImportOutcome.Type;

export const V1ImportItemKind = Schema.Literals(["integration", "connection", "tool_policy"]);
export type V1ImportItemKind = typeof V1ImportItemKind.Type;

export const V1ImportItem = Schema.Struct({
  kind: V1ImportItemKind,
  /** The integration's slug, the connection's row id or the policy's id. */
  id: Schema.String,
  label: Schema.String,
  /** The integration a connection or policy belongs to, by label; null for an integration. */
  integration: Schema.NullOr(Schema.String),
  outcome: V1ImportOutcome,
  /** Why it does not simply move. */
  reason: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(V1StaleCategory),
  /** What an import made of it: an integration's app, a connection's account. */
  v2Id: Schema.optionalKey(Schema.String),
  /** What else to know about what moved, such as tools an app leaves out. */
  note: Schema.optionalKey(Schema.String),
});
export type V1ImportItem = typeof V1ImportItem.Type;

/** One Executor 1 workspace: the folder it ran in named its tenant. */
export const V1ImportWorkspace = Schema.Struct({
  tenant: Schema.String,
  items: Schema.Array(V1ImportItem),
});
export type V1ImportWorkspace = typeof V1ImportWorkspace.Type;

export const V1ImportReport = Schema.Struct({
  from: Schema.String,
  dryRun: Schema.Boolean,
  workspaces: Schema.Array(V1ImportWorkspace),
});
export type V1ImportReport = typeof V1ImportReport.Type;

/** Why an Executor 1 data directory cannot be read at all, or the import cannot keep its record. */
export const V1ImportProblem = Schema.Literals([
  "no_database",
  "unreadable_database",
  "unreadable_rows",
  "unreadable_credentials",
  "unknown_workspace",
  "unreadable_record",
  "unwritable_record",
]);
export type V1ImportProblem = typeof V1ImportProblem.Type;

const problems: Record<V1ImportProblem, string> = {
  no_database:
    "The directory has no Executor 1 database (data.db). Pass Executor 1's data directory with --from.",
  unreadable_database:
    "Executor 1's database could not be read. Check that it is an Executor 1 data directory.",
  unreadable_rows:
    "Executor 1's database has rows the import cannot read. They may be from an Executor 1 release the import does not know.",
  unreadable_credentials: "Executor 1's auth.json is not a JSON object of saved credentials.",
  unknown_workspace:
    "Executor 1's database has no such workspace. Run without --workspace to list them.",
  unreadable_record:
    "This Executor's record of earlier Executor 1 imports (v1-import.json in its data directory) could not be read.",
  unwritable_record:
    "This Executor could not save its record of what the import moved (v1-import.json in its data directory). Run the import again; it continues where it stopped.",
};

/**
 * The import could not read Executor 1's data, or keep its own record of what moved. Its message
 * never names a path outside this Executor's data directory, or a value.
 */
export const V1ImportFailed = ApiError.define({
  tag: "V1ImportFailed",
  status: 422,
  fields: { problem: V1ImportProblem },
  message: ({ problem }) => problems[problem],
  recorded: ({ problem }) => `v1 import failed: ${problem}`,
});
export type V1ImportFailed = typeof V1ImportFailed.Type;

/**
 * Import some of one workspace's integrations, with their connections. The command sends a few
 * at a time, so each request ends well within an HTTP response's limits and shows progress.
 */
export const V1ImportRequest = Schema.Struct({
  /** Executor 1's data directory, as the command resolved it. */
  from: Schema.String,
  workspace: Schema.String,
  /** The integrations' slugs. */
  integrations: Schema.Array(Schema.String),
  /**
   * The command's own `PATH`, which a local (stdio) server's command is found on unless Executor 1
   * set one. The background server may run with a shorter one, as a login service does. Absent
   * when the command has none, which leaves the server's own.
   */
  path: Schema.optionalKey(Schema.NonEmptyString),
});
export type V1ImportRequest = typeof V1ImportRequest.Type;

/**
 * What the request's integrations, their connections, and the tool policies naming them became,
 * as this import found them in Executor 1's rows when it ran.
 */
export const V1ImportBatch = Schema.Struct({ items: Schema.Array(V1ImportItem) });
export type V1ImportBatch = typeof V1ImportBatch.Type;

/** The import, run by the background Executor that owns this Executor's data. */
const localV1ImportApi = HttpApi.make("local-v1-import").add(
  HttpApiGroup.make("v1Import").add(
    HttpApiEndpoint.post("run", "/v1/local/v1-import", {
      payload: V1ImportRequest,
      success: V1ImportBatch,
      error: [V1ImportFailed],
    })
      .annotate(OpenApi.Summary, "Import an Executor 1 data directory")
      .annotate(
        OpenApi.Description,
        "Move some of a local Executor 1 workspace's integrations, with their connections and the tool policies naming them, into this Executor, and report what each became. An item an earlier request moved is not moved again.",
      ),
  ),
);
/** Every endpoint answers a request its schema rejects with `RequestInvalid`. */
export const LocalV1ImportApi = localV1ImportApi.middleware(RequestRejection);
