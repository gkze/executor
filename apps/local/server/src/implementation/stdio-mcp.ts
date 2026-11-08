/**
 * Local (stdio) MCP servers, run by this server for the apps that call them.
 *
 * App code runs in isolates that cannot start processes. For each bridged server the host keeps
 * the command in `stdio-mcp.json`, starts it on first use and keeps it running, and serves it as
 * a Streamable HTTP MCP endpoint on loopback. The server's app is an ordinary `mcpRouter` app whose
 * one app-scope account, held and refreshed by the host, carries that endpoint's URL and token.
 *
 * Each endpoint request gets its own stateless MCP server in front of the one long-lived client of
 * the child process: the app's client opens a connection per discovery or call and initializes it,
 * which a long-lived stdio server would refuse to do twice. Only tools are bridged; a server's
 * list-change notifications reach the app on its next discovery.
 *
 * A child that exits is started again by the next request. One that fails to start is not tried
 * again until `startCooldownMs` has passed. Children are closed when this server stops; if it is
 * killed instead, each child sees its stdin close, which ends a stdio server.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { hostBridgedMcpSource, type GeneratedToolRules } from "@executor-js/app-templates";
import { AccountId, AppId, type App, type Executor } from "@executor-js/sdk/core";
import { Effect, FileSystem, Path, Redacted, Schema, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { SqlClient } from "effect/sql";
import type { ServerConfig } from "../contracts/config.ts";
import {
  stdioAccount,
  StdioBridgeFailed,
  type StdioCommand,
  StdioRegistry,
  type StdioServer,
} from "../contracts/stdio-mcp.ts";
import { linkAccount } from "./app-accounts.ts";
import { writeAtomically } from "./atomic-file.ts";
import { bearerMatches } from "./auth.ts";
import { localOwner } from "./owners.ts";

const registryFile = "stdio-mcp.json";

/** How long the child may take to start and answer `initialize`. */
const startTimeoutMs = 30_000;
/** How long a server that failed to start is refused before it is tried again. */
const startCooldownMs = 10_000;
/**
 * The bridge's own bound on one request to the child, for a caller that never disconnects. The
 * app's client sets the deadline the caller sees; a disconnect aborts the request at once.
 */
const requestTimeoutMs = 15 * 60_000;
/** The longest line of a child's stderr that reaches the log. */
const stderrLineLimit = 2_000;

/**
 * Host variables a child inherits on top of the SDK's safe list (HOME, PATH, SHELL, TERM, USER,
 * LOGNAME), which the transport adds itself, as Executor 1 passed them: the proxy and CA settings HTTPS needs behind an
 * intercepting proxy. None carries a credential. A server's declared `env` wins on a collision.
 */
const inheritedEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

const childEnvironment = (declared: StdioCommand["env"]) => ({
  ...Object.fromEntries(
    inheritedEnvKeys.flatMap((key) => {
      const value = process.env[key];
      return value === undefined || value === "" ? [] : [[key, value] as const];
    }),
  ),
  ...declared,
});

/**
 * The source of a bridged server's app, with its tool rules: the endpoint comes from its account,
 * not its source. Its endpoint provider is the server's own, so one server's endpoint account
 * never fills another app's requirement. Its name keeps the v1 integration's identity, which
 * stays the same across imports and renames.
 */
export const stdioAppSource = (
  server: { readonly name: string; readonly tenant: string; readonly integration: string },
  rules?: GeneratedToolRules,
) => {
  const key = createHash("sha256")
    .update(`${server.tenant}\u0000${server.integration}`)
    .digest("hex")
    .slice(0, 8);
  return hostBridgedMcpSource(
    server.name,
    { ...stdioAccount, provider: `${server.name} endpoint (${key})` },
    rules,
  );
};

const sameCommand = (left: StdioCommand, right: StdioCommand) =>
  left.command === right.command &&
  left.cwd === right.cwd &&
  JSON.stringify(left.args) === JSON.stringify(right.args) &&
  JSON.stringify(Object.entries(left.env).sort()) ===
    JSON.stringify(Object.entries(right.env).sort());

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The bridged servers' commands, endpoints and running children. */
export const makeStdioMcp = (input: {
  readonly executor: Executor;
  readonly sql: SqlClient.SqlClient;
  readonly directory: string;
  readonly platform: string;
  readonly config: Pick<ServerConfig, "port" | "apiKey">;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<never>();
    const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const { executor } = input;
    const file = path.join(input.directory, registryFile);
    const lock = yield* Semaphore.make(1);

    const read = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return { servers: {} } satisfies StdioRegistry;
      return yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(StdioRegistry))));
    }).pipe(Effect.mapError(() => new StdioBridgeFailed({ reason: "registry_unreadable" })));
    /** Change the registry under the lock, so concurrent changes never drop each other. */
    const update = (change: (registry: StdioRegistry) => StdioRegistry) =>
      Effect.flatMap(read, (registry) =>
        writeAtomically(
          input.platform,
          input.directory,
          file,
          `${JSON.stringify(change(registry), null, 2)}\n`,
        ).pipe(Effect.mapError(() => new StdioBridgeFailed({ reason: "registry_unwritable" }))),
      );

    /**
     * Each endpoint's token, derived from the local API key: it changes when the key does, and
     * nothing extra is stored. The key already authorizes everything a token allows.
     */
    const token = (id: string) =>
      createHmac("sha256", Redacted.value(input.config.apiKey))
        .update(`stdio-mcp:${id}`)
        .digest("base64url");
    const fields = (id: string) =>
      Redacted.make({
        url: `http://127.0.0.1:${input.config.port}/stdio-mcp/${id}/mcp`,
        token: token(id),
      });

    /** Running children by server id; a child that closes removes itself. */
    const running = new Map<string, Promise<Client>>();
    /** When each server last failed to start. */
    const failedAt = new Map<string, number>();

    const start = (server: StdioServer) => {
      const transport = new StdioClientTransport({
        command: server.command,
        args: [...server.args],
        env: childEnvironment(server.env),
        ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
        stderr: "pipe",
      });
      // Debug, not info: a server's stderr can hold its own secrets, and logs may be exported.
      if (transport.stderr instanceof Readable)
        createInterface({ input: transport.stderr }).on("line", (line) => {
          Effect.runForkWith(services)(
            Effect.logDebug("Local MCP server output").pipe(
              Effect.annotateLogs({ server: server.label, line: line.slice(0, stderrLineLimit) }),
            ),
          );
        });
      const client = new Client({ name: "executor-local-stdio", version: "1.0.0" });
      let connected: Promise<Client> | undefined;
      // Set before `connect`, which chains it with the client's own handling: replacing it later
      // would stop the client from failing the requests a dead child leaves open.
      transport.onclose = () => {
        if (connected !== undefined && running.get(server.id) === connected)
          running.delete(server.id);
      };
      connected = client.connect(transport, { timeout: startTimeoutMs }).then(
        () => client,
        (error: unknown) => {
          failedAt.set(server.id, Date.now());
          // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK cleanup
          void client.close().catch(() => undefined);
          throw error;
        },
      );
      running.set(server.id, connected);
      return connected;
    };

    /** The server's connected client, starting its child when none runs. */
    const clientFor = (server: StdioServer) => {
      const failed = failedAt.get(server.id);
      if (failed !== undefined && Date.now() - failed < startCooldownMs)
        return Effect.fail("it failed to start moments ago and is tried again shortly");
      return Effect.tryPromise({
        try: () => running.get(server.id) ?? start(server),
        catch: message,
      });
    };

    const stop = (id: string) =>
      Effect.promise(async () => {
        const pending = running.get(id);
        running.delete(id);
        failedAt.delete(id);
        // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK cleanup
        await pending?.then((client) => client.close()).catch(() => undefined);
      });

    yield* Effect.addFinalizer(() => Effect.forEach([...running.keys()], stop, { discard: true }));

    /** Answer one MCP request with a stateless server in front of the child's client. */
    const serve = (client: Client, request: Request) => {
      const instructions = client.getInstructions();
      const server = new Server(client.getServerVersion() ?? { name: "stdio", version: "0.0.0" }, {
        capabilities: { tools: {} },
        ...(instructions === undefined ? {} : { instructions }),
      });
      server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
        client.listTools(request.params, { signal: extra.signal, timeout: requestTimeoutMs }),
      );
      server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
        client.request({ method: "tools/call", params: request.params }, CallToolResultSchema, {
          signal: extra.signal,
          timeout: requestTimeoutMs,
        }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      // oxlint-disable-next-line executor/authored-code-through-adapter -- MCP SDK
      return server
        .connect(transport)
        .then(() => transport.handleRequest(request))
        .finally(() => server.close());
    };

    /**
     * The server's endpoint account, found or made again, given the current endpoint and linked to
     * its app. A person who deletes it gets it back on the next import or restart.
     */
    const ensureEndpoint = (server: Pick<StdioServer, "id" | "account" | "label">, app: App) =>
      Effect.gen(function* () {
        const requirement = app.requirements.accounts[stdioAccount.requirement];
        if (requirement === undefined)
          return yield* new StdioBridgeFailed({ reason: "no_endpoint" });
        const recorded =
          server.account === ""
            ? undefined
            : yield* executor.accounts
                .get({ owner: localOwner, account: AccountId.make(server.account) })
                .pipe(Effect.catchTag("AccountNotFound", () => Effect.succeed(undefined)));
        // An account of another provider cannot fill the app's requirement: a new version of the
        // app may declare a different endpoint provider, so make one that fits.
        const existing = recorded?.provider === requirement.provider ? recorded : undefined;
        const account =
          existing === undefined
            ? yield* executor.managedAccounts.add({
                owner: localOwner,
                provider: requirement.provider,
                method: stdioAccount.method,
                label: `${server.label} endpoint`,
                fields: fields(server.id),
              })
            : yield* executor.managedAccounts.replaceCredentials({
                owner: localOwner,
                account: existing.id,
                fields: fields(server.id),
              });
        yield* linkAccount(input.sql, executor, {
          app: app.id,
          scope: "app",
          requirement: stdioAccount.requirement,
          account: account.id,
        });
        return {
          account: account.id,
          replaced: recorded !== undefined && existing === undefined ? recorded.id : undefined,
        };
      });

    /** Forget a server whose app is gone: its child, its record and its endpoint account. */
    const detach = (server: StdioServer) =>
      Effect.gen(function* () {
        yield* stop(server.id);
        yield* lock.withPermits(1)(
          update((registry) => ({
            servers: Object.fromEntries(
              Object.entries(registry.servers).filter(([id]) => id !== server.id),
            ),
          })),
        );
        if (server.account !== "")
          yield* executor.accounts
            .remove({ owner: localOwner, account: AccountId.make(server.account) })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Local MCP server endpoint account was not removed").pipe(
                  Effect.annotateLogs({ server: server.label, error: String(error) }),
                ),
              ),
            );
      });

    /** The app a server serves, or none when it was deleted. */
    const appOf = (server: StdioServer) =>
      executor.apps
        .get({ app: AppId.make(server.app) })
        .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));

    const http = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Only app code calls this route; a browser page never may.
      if (request.headers.origin !== undefined) return HttpServerResponse.empty({ status: 403 });
      const { id } = yield* HttpRouter.schemaPathParams(Schema.Struct({ id: Schema.String }));
      // Refuse a missing token before looking the id up, so the answer never tells whether it exists.
      if (!bearerMatches(request.headers.authorization, [Redacted.make(token(id))]))
        return HttpServerResponse.empty({ status: 401 });
      const server = (yield* read).servers[id];
      if (server === undefined) return HttpServerResponse.empty({ status: 404 });
      if ((yield* appOf(server)) === undefined) {
        yield* detach(server);
        return HttpServerResponse.empty({ status: 404 });
      }
      const client = yield* clientFor(server).pipe(Effect.result);
      if (client._tag === "Failure") {
        yield* Effect.logWarning("Local MCP server did not start").pipe(
          Effect.annotateLogs({ server: server.label, command: server.command }),
        );
        return HttpServerResponse.text(`The local MCP server could not start: ${client.failure}`, {
          status: 502,
        });
      }
      const web = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        // The caller's disconnect interrupts this effect, which aborts the request to the child.
        try: (signal) => serve(client.success, new Request(web, { signal })),
        catch: message,
      }).pipe(Effect.result);
      if (response._tag === "Failure")
        return HttpServerResponse.text(
          `The local MCP server stopped responding: ${response.failure}`,
          { status: 502 },
        );
      return HttpServerResponse.fromWeb(response.success);
    }).pipe(
      Effect.catchTags({
        SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
        StdioBridgeFailed: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      }),
    );

    /**
     * Make the server's endpoint account current, and record its id when it had to be made again.
     * Call with the lock held.
     */
    const refreshEndpoint = (server: StdioServer, app: App) =>
      Effect.gen(function* () {
        const { account, replaced } = yield* ensureEndpoint(server, app);
        if (account !== server.account)
          yield* update((current) => {
            const recorded = current.servers[server.id];
            return recorded === undefined
              ? current
              : { servers: { ...current.servers, [server.id]: { ...recorded, account } } };
          });
        // Only once the record names its successor, so an interruption never leaves it naming a
        // removed account.
        if (replaced !== undefined)
          yield* executor.accounts
            .remove({ owner: localOwner, account: replaced })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Replaced endpoint account was not removed").pipe(
                  Effect.annotateLogs({ server: server.label, error: String(error) }),
                ),
              ),
            );
        return account;
      });

    /**
     * Give a deployed bridged app its server, or update the one it has: its command, recorded
     * under the lock, and its endpoint account, made again if missing and linked for the app.
     * Running it again for the same app and command changes nothing; a new command takes effect
     * on the next request.
     */
    const attach = (app: App, label: string, command: StdioCommand) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const registry = yield* read;
          const existing = Object.values(registry.servers).find((server) => server.app === app.id);
          const id = existing?.id ?? randomUUID();
          const record = (account: string): StdioServer => ({
            id,
            app: app.id,
            account,
            label,
            ...command,
          });
          // Record the server before making its account, so an interrupted attach is resumed,
          // not repeated with a second account.
          const server = record(existing?.account ?? "");
          yield* update((current) => ({ servers: { ...current.servers, [id]: server } }));
          if (existing !== undefined && !sameCommand(existing, command)) yield* stop(id);
          return record(yield* refreshEndpoint(server, app));
        }),
      );

    /**
     * At startup: forget servers whose app was deleted, and give every remaining endpoint account
     * this process's port and key. A failure leaves only the affected server unserved.
     */
    const reconcile = Effect.gen(function* () {
      const registry = yield* read;
      for (const server of Object.values(registry.servers)) {
        yield* Effect.gen(function* () {
          const app = yield* appOf(server);
          if (app === undefined) yield* detach(server);
          else yield* lock.withPermits(1)(refreshEndpoint(server, app));
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Local MCP server could not be reconciled").pipe(
              Effect.annotateLogs({ server: server.label, error: String(error) }),
            ),
          ),
        );
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Local MCP servers are unavailable").pipe(
          Effect.annotateLogs({ error: String(error) }),
        ),
      ),
    );

    /**
     * After an app's removal commits: stop and forget the servers it ran, with their endpoint
     * accounts. The app is read again first, so a removal that did not happen forgets nothing.
     */
    const forget = (app: AppId) =>
      Effect.gen(function* () {
        const registry = yield* read;
        for (const server of Object.values(registry.servers).filter((entry) => entry.app === app))
          if ((yield* appOf(server)) === undefined) yield* detach(server);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Local MCP server of a removed app was not forgotten").pipe(
            Effect.annotateLogs({ app, error: String(error) }),
          ),
        ),
        // Runs from the executor's removal, outside this server's own services.
        Effect.provideContext(platform),
      );

    return { http, attach, reconcile, forget };
  });

export type StdioMcp = Effect.Success<ReturnType<typeof makeStdioMcp>>;
