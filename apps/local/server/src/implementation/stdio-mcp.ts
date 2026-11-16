/**
 * Stdio MCP servers the local server runs for apps.
 *
 * Apps run in workerd and cannot start processes. For a server that speaks MCP only over stdio,
 * this server starts the command itself and serves it at `/stdio-mcp/<id>` over Streamable HTTP.
 * The server's generated app reaches that URL with `mcpRouter`, as it would any MCP server. The
 * command belongs to the product: it is recorded here when the server is added, through the local
 * API, and app source names only the bridge URL.
 *
 * Access. Each server's app has one account, provisioned here, holding a random bridge token and
 * the server's secret variables. Its provider declares the bridge's host, so app code holds
 * handles and the app network substitutes the values only on requests to the bridge. The bridge
 * accepts a request only with the token whose SHA-256 it keeps, and reads the secret variables
 * from the headers of the `initialize` request that starts a session. Requests with a browser
 * `Origin`, or whose `Host` is not this server's loopback address, are refused first; the token is
 * the barrier that matters.
 *
 * Processes. One child serves every session with the same secret values: mcp-proxy's
 * `proxyServer` forwards each session's requests over one MCP client, which numbers its own
 * requests, so callers that open a session per operation, as `mcpRouter` does, share a process.
 * Different secret values, as from a second account, start a second child, at most
 * `maxProcessesPerServer` per server. Only an `initialize` starts a child. A child stops when it
 * has had no session for `processIdleMs`, when the server stops, or by exiting. A child that stops
 * is forgotten before anything else, so the next session starts a new one. Its sessions take no
 * new request (their callers are answered 404 and start new sessions) and close once the responses
 * they are sending end, so a request the child was serving answers with its error at once. A
 * session with no request for `sessionIdleMs` is closed.
 *
 * Elicitation. A stdio message does not say which request caused it. A child's question is sent
 * on the response stream of the one tool call in progress on that child, and declined when there
 * is none or several, because sending it to the wrong caller would show one caller another's
 * question.
 *
 * Environment. A child gets the MCP SDK's short default list (such as `PATH` and `HOME`), the
 * proxy and certificate variables below, the server's plain variables and its secret variables, in
 * increasing precedence. Nothing else of this process's environment reaches it, so the key that
 * decrypts the local store does not. Its stderr is discarded: it can quote secrets, and nothing
 * here can show it safely. The command runs without a shell, so on Windows a `.cmd` launcher such
 * as `npx` must be named in full or run through `cmd.exe`.
 *
 * Implementation source. Sharing a process needs MCP-level proxying: request IDs, progress,
 * cancellation, list-changed notifications and both protocol eras. mcp-proxy provides it, and the
 * MCP SDK's web-standard transport serves each session. The strongest alternative was rewriting
 * JSON-RPC IDs here; supergateway starts a process per session. Only `proxyServer` is used:
 * mcp-proxy's own HTTP server would add a second listener and its own authentication.
 */
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { proxyServer } from "mcp-proxy";
import { generateMcpSource } from "@executor-js/app-templates";
import { StorageError, type Executor } from "@executor-js/sdk/core";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { Hex } from "effect/encoding";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import type { SqlClient } from "effect/sql";
import type { ServerConfig } from "../contracts/config.ts";
import {
  bridgeTokenField,
  LocalStdioMcpApi,
  StdioMcpServerId,
  type StdioMcpServerInput,
} from "../contracts/stdio-mcp.ts";
import { linkAccount } from "./app-accounts.ts";
import { localOwner } from "./owners.ts";

/** A child that has had no session for this long is stopped. */
const processIdleMs = 5 * 60_000;
/** A session with no request for this long is closed; `mcpRouter` closes its own sooner. */
const sessionIdleMs = 10 * 60_000;
/** How often idle sessions and children are looked for. */
const sweepInterval = "30 seconds";
/** Children one server may run at once, one per distinct set of secret values. */
const maxProcessesPerServer = 4;
/** How long a child has to start and answer `initialize`; `npx` may download the package first. */
const startTimeoutMs = 60_000;

/** The header that carries a secret variable's value. Header names ignore case. */
const secretHeader = (name: string) => `x-executor-env-${name.toLowerCase()}`;
/** The bridge's route, and one server's path on it. */
const bridgeRoute = "/stdio-mcp/:server" as const;
const bridgePath = (server: StdioMcpServerId) => bridgeRoute.replace(":server", server);

/**
 * Host variables a child inherits beside the SDK's list, as v1 passed them: a child sits behind
 * the same proxy and intercepting CA as this process, and none of them carries a credential. The
 * lowercase spellings are read by libcurl and most Unix tools, the uppercase ones by Node.
 */
const inheritedKeys = [
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

/**
 * Merge environment sources in increasing precedence, by the key identity the platform has. On
 * Windows `Path` and `PATH` are one variable, so keys merge ignoring case, a later source wins and
 * keeps one spelling, and a key the SDK also sets takes the SDK's spelling, because the SDK spreads
 * its own list underneath the result and a different spelling would sit beside it.
 */
const mergeEnvironment = (
  platform: NodeJS.Platform,
  sources: ReadonlyArray<Readonly<Record<string, string>>>,
  sdkKeys: ReadonlyArray<string>,
): Record<string, string> => {
  if (platform !== "win32") return Object.assign({}, ...sources);
  const sdkSpelling = new Map(sdkKeys.map((key) => [key.toLowerCase(), key] as const));
  const merged = new Map<string, readonly [string, string]>();
  for (const source of sources)
    for (const [key, value] of Object.entries(source)) {
      const identity = key.toLowerCase();
      merged.set(identity, [sdkSpelling.get(identity) ?? key, value]);
    }
  return Object.fromEntries(merged.values());
};

/** A child's environment; read when it starts, as the host's proxy settings can change. */
const childEnvironment = (
  env: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
) =>
  mergeEnvironment(
    process.platform,
    [
      Object.fromEntries(
        inheritedKeys.flatMap((key) => {
          const value = process.env[key];
          return value === undefined || value === "" ? [] : [[key, value] as const];
        }),
      ),
      env,
      secrets,
    ],
    Object.keys(getDefaultEnvironment()),
  );

const ServerRow = Schema.Struct({
  id: StdioMcpServerId,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  secrets: Schema.Array(Schema.String),
  tokenDigest: Schema.String,
});
type ServerRow = typeof ServerRow.Type;

const storage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new StorageError()));

const readServer = (sql: SqlClient.SqlClient, id: StdioMcpServerId) =>
  sql`select id, command, args, cwd, env, secrets, token_digest as "tokenDigest"
    from local_stdio_mcp_servers where id = ${id}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ServerRow))),
    Effect.map((rows) => rows[0]),
    storage,
  );

const sha256 = (crypto: Crypto, value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
  );
const randomHex = (crypto: Crypto, bytes: number) =>
  Hex.encode(crypto.getRandomValues(new Uint8Array(bytes)));

/** A JSON-RPC request in a POST body, by its ID and method; anything else is not one. */
const JsonRpcRequest = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
});
type RequestId = typeof JsonRpcRequest.Type.id;
const readRequest = (request: Request) =>
  request.method === "POST"
    ? request
        .clone()
        .json()
        .then(Schema.decodeUnknownOption(JsonRpcRequest))
        .catch(() => undefined)
        .then((decoded) => (decoded?._tag === "Some" ? decoded.value : undefined))
    : Promise.resolve(undefined);

/**
 * The same body, which calls `settle` exactly once when it ends, fails or is cancelled by its
 * reader, so a response its caller abandons is not counted as still being sent.
 */
const settledBody = (body: ReadableStream<Uint8Array>, settle: () => void) => {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const chunk = await reader.read().catch((error: unknown) => {
        settle();
        throw error;
      });
      if (chunk.done) {
        settle();
        controller.close();
      } else controller.enqueue(chunk.value);
    },
    cancel: async (reason) => {
      settle();
      await reader.cancel(reason);
    },
  });
};

interface Upstream {
  readonly server: StdioMcpServerId;
  readonly client: Client;
  /** Remove this child from the children by key, if it is still the one there. */
  readonly forget: () => void;
  /** Sessions open on it, and since when it has had none. */
  sessions: number;
  idleSince: number;
}
interface Session {
  readonly server: StdioMcpServerId;
  readonly upstream: Upstream;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly proxy: Server;
  /** Requests whose responses are still being sent, and which of them are tool calls. */
  readonly pending: Set<RequestId>;
  readonly toolCalls: Set<RequestId>;
  lastActive: number;
}
const closeSession = (session: Session) => void session.proxy.close().catch(() => {});

class StdioMcpRefused extends Schema.TaggedError<StdioMcpRefused>()("StdioMcpRefused", {
  status: Schema.Literals([400, 401, 403, 404, 503]),
}) {}
class StdioMcpStartFailed extends Schema.TaggedError<StdioMcpStartFailed>()(
  "StdioMcpStartFailed",
  {},
) {}
/** The MCP SDK failed a request outside the protocol, such as a transport fault. */
class StdioMcpBridgeFailed extends Schema.TaggedError<StdioMcpBridgeFailed>()(
  "StdioMcpBridgeFailed",
  {},
) {}
const bridged = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: () => new StdioMcpBridgeFailed() });

/**
 * The bridge, for the server's lifetime: its children are stopped when the scope closes. Its
 * `http` serves `route`.
 */
export const stdioMcpBridge = (sql: SqlClient.SqlClient, config: ServerConfig, crypto: Crypto) =>
  Effect.gen(function* () {
    /** Children by server and secret values, from the moment they start starting. */
    const upstreams = new Map<string, Promise<Upstream>>();
    /** Every child's client, from creation until it closes, for shutdown. */
    const clients = new Set<Client>();
    const started = new Set<Upstream>();
    /** Sessions that take requests. */
    const sessions = new Map<string, Session>();
    /** Sessions of exited children, still sending responses. */
    const retiring = new Set<Session>();
    let closed = false;

    /** Stop routing requests to a session; its caller's next request is answered 404. */
    const unregister = (id: string) => {
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      sessions.delete(id);
      session.upstream.sessions -= 1;
      if (session.upstream.sessions === 0) session.upstream.idleSince = Date.now();
      return session;
    };
    /** A session its caller closed or left idle: closed at once, with anything it was sending. */
    const dropSession = (id: string) => {
      const session = unregister(id);
      if (session !== undefined) closeSession(session);
    };
    const closeRetiring = (session: Session) => {
      retiring.delete(session);
      closeSession(session);
    };
    /** Forget a child first, so no new session reaches it, then stop it. */
    const stop = (upstream: Upstream) => {
      started.delete(upstream);
      upstream.forget();
      void upstream.client.close().catch(() => {});
    };

    const start = async (row: ServerRow, secrets: Record<string, string>, forget: () => void) => {
      const client = new Client(
        { name: "executor-stdio-bridge", version: "1" },
        { capabilities: { elicitation: { form: {} } } },
      );
      clients.add(client);
      const upstream: Upstream = {
        server: row.id,
        client,
        forget,
        sessions: 0,
        idleSince: Date.now(),
      };
      client.setRequestHandler("elicitation/create", async (request) => {
        const asking = [...sessions.values()].flatMap((session) =>
          session.upstream === upstream
            ? [...session.toolCalls].map((id) => ({ session, id }))
            : [],
        );
        return asking.length === 1
          ? asking[0]!.session.proxy.elicitInput(request.params, {
              relatedRequestId: asking[0]!.id,
            })
          : { action: "decline" as const };
      });
      // The SDK calls this before it fails the child's pending requests. Closing a session now
      // would cut off the error those requests are about to answer with, and leave their callers
      // waiting out their deadlines, so each session closes once its responses have been sent.
      client.onclose = () => {
        clients.delete(client);
        started.delete(upstream);
        forget();
        for (const [id, session] of sessions)
          if (session.upstream === upstream) {
            unregister(id);
            if (session.pending.size === 0) closeSession(session);
            else retiring.add(session);
          }
      };
      await client
        .connect(
          new StdioClientTransport({
            command: row.command,
            args: [...row.args],
            env: childEnvironment(row.env, secrets),
            stderr: "ignore",
            ...(row.cwd === null ? {} : { cwd: row.cwd }),
          }),
          { timeout: startTimeoutMs },
        )
        // A child that started but did not answer in time is stopped, not left running.
        .catch(async (error: unknown) => {
          await client.close().catch(() => {});
          throw error;
        });
      started.add(upstream);
      return upstream;
    };

    /** The child for these secret values, started if needed; refused with 503 at the limit. */
    const acquire = (row: ServerRow, secrets: Record<string, string>) =>
      Effect.gen(function* () {
        if (closed) return yield* new StdioMcpRefused({ status: 503 });
        const values = row.secrets.map((name) => secrets[name] ?? "");
        const key = `${row.id}:${yield* sha256(crypto, JSON.stringify(values))}`;
        if (!upstreams.has(key)) {
          const running = [...upstreams.keys()].filter((other) => other.startsWith(`${row.id}:`));
          if (running.length >= maxProcessesPerServer)
            return yield* new StdioMcpRefused({ status: 503 });
          // Only this child's entry is removed, never a newer one started under the same key.
          const forget = () => {
            if (upstreams.get(key) === starting) upstreams.delete(key);
          };
          const starting = start(row, secrets, forget);
          upstreams.set(key, starting);
          // A child that failed to start leaves nothing behind, so the next session tries again.
          starting.catch(forget);
        }
        return yield* Effect.tryPromise({
          try: () => upstreams.get(key)!,
          catch: () => new StdioMcpStartFailed(),
        });
      });

    /** A new session's transport, whose own session ID is set when `initialize` succeeds. */
    const openSession = async (upstream: Upstream) => {
      const capabilities: ServerCapabilities = upstream.client.getServerCapabilities() ?? {};
      const version = upstream.client.getServerVersion() ?? {
        name: "stdio-mcp-server",
        version: "0",
      };
      const instructions = upstream.client.getInstructions();
      const proxy = new Server(
        { name: version.name, version: version.version },
        { capabilities, ...(instructions === undefined ? {} : { instructions }) },
      );
      await proxyServer({
        client: upstream.client,
        server: proxy,
        serverCapabilities: capabilities,
      });
      const transport: WebStandardStreamableHTTPServerTransport =
        new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            upstream.sessions += 1;
            sessions.set(id, {
              server: upstream.server,
              upstream,
              transport,
              proxy,
              pending: new Set(),
              toolCalls: new Set(),
              lastActive: Date.now(),
            });
          },
          onsessionclosed: dropSession,
        });
      await proxy.connect(transport);
      return { proxy, transport };
    };

    /** Count a request, and a tool call among them, as pending until its response ends. */
    const tracked = async (session: Session, request: Request) => {
      const message = await readRequest(request);
      if (message === undefined) return session.transport.handleRequest(request);
      session.pending.add(message.id);
      if (message.method === "tools/call") session.toolCalls.add(message.id);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        session.pending.delete(message.id);
        session.toolCalls.delete(message.id);
        if (retiring.has(session) && session.pending.size === 0) closeRetiring(session);
      };
      const response = await session.transport.handleRequest(request).catch((error: unknown) => {
        settle();
        throw error;
      });
      if (response.body === null) {
        settle();
        return response;
      }
      return new Response(settledBody(response.body, settle), response);
    };

    const dispatch = (row: ServerRow, request: Request) =>
      Effect.gen(function* () {
        const id = request.headers.get("mcp-session-id");
        if (id !== null) {
          const session = sessions.get(id);
          // An unknown session is 404, which tells the caller to start a new one.
          if (session === undefined || session.server !== row.id)
            return yield* new StdioMcpRefused({ status: 404 });
          session.lastActive = Date.now();
          return yield* bridged(() => tracked(session, request));
        }
        // A request without a session must start one; nothing else starts a child.
        if ((yield* Effect.promise(() => readRequest(request)))?.method !== "initialize")
          return yield* new StdioMcpRefused({ status: 400 });
        const secrets: Record<string, string> = {};
        for (const name of row.secrets) {
          const value = request.headers.get(secretHeader(name));
          if (value === null || value === "") return yield* new StdioMcpRefused({ status: 401 });
          secrets[name] = value;
        }
        const upstream = yield* acquire(row, secrets);
        return yield* bridged(async () => {
          const { proxy, transport } = await openSession(upstream);
          // A request that did not start a session leaves nothing to keep.
          return transport.handleRequest(request).finally(async () => {
            if (transport.sessionId === undefined) await proxy.close().catch(() => {});
          });
        });
      });

    const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
    const http = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      // Only app code and local programs call the bridge; a browser page never may.
      if (request.headers.origin !== undefined || !hosts.has(request.headers.host ?? ""))
        return yield* new StdioMcpRefused({ status: 403 });
      const { server } = yield* HttpRouter.schemaPathParams(
        Schema.Struct({ server: StdioMcpServerId }),
      ).pipe(Effect.mapError(() => new StdioMcpRefused({ status: 404 })));
      const row = yield* readServer(sql, server);
      const token = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
      // An unknown server is refused like a wrong token, so IDs cannot be probed.
      if (
        row === undefined ||
        token === undefined ||
        (yield* sha256(crypto, token)) !== row.tokenDigest
      )
        return yield* new StdioMcpRefused({ status: 401 });
      const web = yield* HttpServerRequest.toWeb(request);
      return HttpServerResponse.fromWeb(yield* dispatch(row, web));
    }).pipe(
      Effect.catchTags({
        StdioMcpRefused: (refused) =>
          Effect.succeed(HttpServerResponse.empty({ status: refused.status })),
        StdioMcpStartFailed: () =>
          Effect.logWarning("Stdio MCP server did not start").pipe(
            Effect.as(HttpServerResponse.empty({ status: 502 })),
          ),
        StdioMcpBridgeFailed: () =>
          Effect.logWarning("Stdio MCP bridge request failed").pipe(
            Effect.as(HttpServerResponse.empty({ status: 502 })),
          ),
        StorageError: () => Effect.succeed(HttpServerResponse.empty({ status: 503 })),
      }),
    );

    const sweep = Effect.sync(() => {
      const now = Date.now();
      for (const [id, session] of sessions)
        if (now - session.lastActive > sessionIdleMs) dropSession(id);
      // A response its caller stopped reading without cancelling never ends.
      for (const session of retiring)
        if (now - session.lastActive > sessionIdleMs) closeRetiring(session);
      for (const upstream of started)
        if (upstream.sessions === 0 && now - upstream.idleSince > processIdleMs) stop(upstream);
    });
    yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(sweepInterval))));
    // Closing a client stops its child, including one still starting.
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        closed = true;
        return Promise.allSettled([...clients].map((client) => client.close()));
      }),
    );
    return { route: bridgeRoute, http };
  });

/** Log a cleanup that failed, apart from the failure that caused it. */
const cleanup = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logError(`Stdio MCP server ${what} failed`, cause)),
  );

/**
 * `stdioMcpServers.create`: deploy the server's app, record the server, and provision and link
 * the account that holds its bridge token and secret variables. A failure after deploying removes
 * the app, which removes the record and links with it, and any account it made.
 */
export const stdioMcpHandlers = (
  executor: Executor,
  sql: SqlClient.SqlClient,
  config: ServerConfig,
  crypto: Crypto,
) => {
  const create = (input: StdioMcpServerInput) =>
    Effect.gen(function* () {
      const id = StdioMcpServerId.make(`stdio_${randomHex(crypto, 16)}`);
      const token = randomHex(crypto, 32);
      const secrets = Object.entries(input.secrets ?? {});
      const generated = yield* generateMcpSource(
        input.name,
        `http://127.0.0.1:${config.port}${bridgePath(id)}`,
        {
          kind: "methods",
          methods: {
            bridge: {
              kind: "secrets",
              label: "Local process",
              fields: [bridgeTokenField, ...secrets.map(([name]) => name)],
              placements: [
                {
                  carrier: "header",
                  name: "authorization",
                  prefix: "Bearer ",
                  field: bridgeTokenField,
                },
                ...secrets.map(([name]) => ({
                  carrier: "header" as const,
                  name: secretHeader(name),
                  field: name,
                })),
              ],
            },
          },
        },
        // The URL and names are this server's own, so a template failure is a defect here.
      ).pipe(Effect.orDie);
      // Deploying refuses a name the owner already uses, inside its own transaction.
      const { app } = yield* executor.apps.deploy({
        owner: localOwner,
        name: input.name,
        files: generated.files,
      });
      const provision = Effect.gen(function* () {
        yield* sql`insert into local_stdio_mcp_servers
            (id, app, command, args, cwd, env, secrets, token_digest)
          values (${id}, ${app.id}, ${input.command}, ${JSON.stringify(input.args ?? [])}::jsonb,
            ${input.cwd ?? null}, ${JSON.stringify(input.env ?? {})}::jsonb,
            ${JSON.stringify(secrets.map(([name]) => name))}::jsonb,
            ${yield* sha256(crypto, token)})`.pipe(storage);
        const requirement = app.requirements.accounts.service;
        if (requirement === undefined) return yield* Effect.die("The generated app has no account");
        const account = yield* executor.managedAccounts.add({
          owner: localOwner,
          provider: requirement.provider,
          method: "bridge",
          label: input.name,
          fields: Redacted.make({
            [bridgeTokenField]: token,
            ...Object.fromEntries(secrets.map(([name, value]) => [name, Redacted.value(value)])),
          }),
        });
        yield* linkAccount(sql, executor, {
          app: app.id,
          scope: "user",
          requirement: "service",
          account: account.id,
        }).pipe(
          // The generated app declares this requirement, so a mismatch is a defect here.
          Effect.catchTag("RequirementMismatch", (mismatch) => Effect.die(mismatch)),
          Effect.onError(() =>
            cleanup(
              "account removal",
              executor.accounts.remove({ owner: localOwner, account: account.id }),
            ),
          ),
        );
        return { app, account: account.id };
      });
      return yield* provision.pipe(
        Effect.onError(() =>
          cleanup("app removal", executor.apps.remove({ owner: localOwner, app: app.id })),
        ),
      );
    });
  return HttpApiBuilder.group(LocalStdioMcpApi, "stdioMcpServers", (handlers) =>
    Effect.succeed(handlers.handle("create", ({ payload }) => create(payload))),
  );
};
