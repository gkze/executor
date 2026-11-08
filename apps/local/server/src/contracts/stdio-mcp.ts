/**
 * Local (stdio) MCP servers. App code runs in isolates that cannot start processes, so the local
 * server starts each configured command itself and serves it to that server's app over loopback
 * Streamable HTTP (`/stdio-mcp/:id/mcp`). The command lives here, in the host's data directory,
 * never in app source: an app, or an agent editing one, cannot choose what runs.
 */
import { Schema } from "effect";

/** What the host runs: a command found on `env.PATH` or by absolute path. */
export const StdioCommand = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  /**
   * Non-secret environment set on top of the host's safe list; never a credential. An import
   * includes the importing shell's `PATH`, because the background server may run without one.
   */
  env: Schema.Record(Schema.String, Schema.String),
  cwd: Schema.optionalKey(Schema.NonEmptyString),
});
export type StdioCommand = typeof StdioCommand.Type;

/** One bridged server: the app that calls it, the host-held account it calls with, and its command. */
export const StdioServer = Schema.Struct({
  id: Schema.NonEmptyString,
  app: Schema.NonEmptyString,
  /** Empty while an attach is making the account. */
  account: Schema.String,
  label: Schema.String,
  ...StdioCommand.fields,
});
export type StdioServer = typeof StdioServer.Type;

/** `stdio-mcp.json` in the data directory, by server id. */
export const StdioRegistry = Schema.Struct({
  servers: Schema.Record(Schema.String, StdioServer),
});
export type StdioRegistry = typeof StdioRegistry.Type;

/** The account requirement a bridged app declares, and the provider's method its account uses. */
export const stdioAccount = { requirement: "bridge", method: "endpoint" } as const;

/**
 * The bridge could not do what was asked: `stdio-mcp.json` could not be read or written, or the
 * app does not declare the endpoint account a bridged app must.
 */
export class StdioBridgeFailed extends Schema.TaggedError<StdioBridgeFailed>()(
  "StdioBridgeFailed",
  { reason: Schema.Literals(["registry_unreadable", "registry_unwritable", "no_endpoint"]) },
) {}
