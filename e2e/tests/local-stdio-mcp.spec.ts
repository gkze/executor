/**
 * Local (stdio) MCP servers run on this computer. `executor import-v1` turns an Executor 1 stdio
 * integration into an app whose command the background Executor starts and keeps running; app
 * calls reach it through a loopback endpoint that only the app's own token opens.
 */
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Path, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { backgroundServiceCli } from "../support/background-service.ts";
import { writeV1LocalData } from "../support/v1-local-data.ts";

const workspace = "stdio-5e6f7a8b";

/**
 * A stdio MCP server with no dependencies. It answers `initialize` once per process, as stdio
 * servers expect to, and its tool reports the environment it was started with and its process id.
 */
const greeter = `
import { createInterface } from "node:readline";
let initialized = false;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    if (initialized) return send({ id: message.id, error: { code: -32600, message: "Already initialized" } });
    initialized = true;
    return send({ id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "greeter", version: "1.0.0" },
    } });
  }
  if (message.method === "tools/list")
    return send({ id: message.id, result: { tools: [{
      name: "greet",
      description: "Greet someone",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    }, {
      name: "crash",
      description: "Exit in the middle of the call",
      inputSchema: { type: "object", properties: {} },
    }] } });
  if (message.method === "tools/call" && message.params.name === "crash") process.exit(1);
  if (message.method === "tools/call")
    return send({ id: message.id, result: { content: [{
      type: "text",
      text: process.env.GREETING + ", " + message.params.arguments.name + " (pid " + process.pid + ")",
    }] } });
  send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
`;

const Report = Schema.Struct({
  workspaces: Schema.Array(
    Schema.Struct({
      tenant: Schema.String,
      items: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          outcome: Schema.String,
          reason: Schema.optionalKey(Schema.String),
          category: Schema.optionalKey(Schema.String),
          v2Id: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});

const Registry = Schema.Struct({
  servers: Schema.Record(
    Schema.String,
    Schema.Struct({ id: Schema.String, app: Schema.String, command: Schema.String }),
  ),
});

layer(TestLive, { excludeTestServices: true })("Local stdio MCP servers", (it) => {
  it.effect(
    scenarios.localStdioMcpBridge.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            http = yield* HttpClient.HttpClient;
          const cli = yield* backgroundServiceCli();
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-stdio-" });
          const script = path.join(root, "greeter.mjs");
          // A command name only the importing shell can resolve.
          const runtime = "greeter-node";
          const bin = path.join(root, "bin");
          yield* fs.makeDirectory(bin);
          yield* fs.symlink(process.execPath, path.join(bin, runtime));
          yield* fs.writeFileString(script, greeter);
          const v1 = path.join(root, "v1");
          yield* writeV1LocalData(v1, {
            integrations: [
              {
                tenant: workspace,
                slug: "greeter",
                plugin: "mcp",
                name: "Greeter",
                config: {
                  transport: "stdio",
                  command: runtime,
                  args: [script],
                  env: { GREETING: "Hello" },
                  authenticationTemplate: [{ slug: "none", kind: "none" }],
                },
              },
              {
                tenant: workspace,
                slug: "codexPlugin",
                plugin: "mcp",
                name: "Codex plugin",
                config: {
                  transport: "stdio",
                  command: "codex",
                  args: ["app-server"],
                  appServer: { server: "computer-use" },
                  authenticationTemplate: [{ slug: "none", kind: "none" }],
                },
              },
            ],
            connections: [
              {
                tenant: workspace,
                rowId: "conn_greeter",
                integration: "greeter",
                name: "default",
                template: "none",
                provider: "file",
                items: {},
              },
            ],
            policies: [],
            credentials: {},
          });

          // The background Executor's own PATH does not name the command; only the shell that
          // runs the import does, as when the desktop app started the server with a GUI app's PATH.
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const shell = { PATH: `${bin}:${process.env.PATH ?? ""}` };
          const imported = yield* cli.run(["import-v1", "--from", v1, "--json"], shell);
          expect(imported.code, imported.stderr).toBe(0);
          const report = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(imported.stdout);
          const items = report.workspaces.find((entry) => entry.tenant === workspace)?.items;
          const item = (id: string) => items?.find((candidate) => candidate.id === id);
          expect(item("greeter")).toMatchObject({ outcome: "moves", v2Id: expect.any(String) });
          expect(item("conn_greeter")).toMatchObject({ outcome: "moves" });
          // Executor 1's Codex app-server adapter speaks its own protocol, which has no bridge.
          expect(item("codexPlugin")).toMatchObject({
            outcome: "cannot_move",
            category: "local_server",
          });
          const app = String(item("greeter")?.v2Id);

          const registration = yield* cli.registered;
          // Each call reads the running service's password, which a restart may change.
          const callTool = (tool: string, input: Record<string, string>) =>
            Effect.flatMap(cli.registered, (current) =>
              http.execute(
                HttpClientRequest.post(`${cli.url}/v1/tools/call`).pipe(
                  HttpClientRequest.bearerToken(Redacted.value(current.password)),
                  HttpClientRequest.bodyJsonUnsafe({ app, tool, input }),
                ),
              ),
            ).pipe(
              Effect.flatMap((response) =>
                response.text.pipe(Effect.map((body) => ({ status: response.status, body }))),
              ),
            );
          const call = (name: string) => callTool("greet", { name });
          // The tool runs in the command Executor started, with Executor 1's environment.
          const first = yield* call("Ada");
          expect(first.status, first.body).toBe(200);
          expect(first.body).toContain("Hello, Ada (pid ");
          // A second call reaches the same process, which was initialized only once.
          const second = yield* call("Grace");
          expect(second.status, second.body).toBe(200);
          expect(second.body).toContain("Hello, Grace (pid ");
          const pid = (body: string) => /\(pid (\d+)\)/.exec(body)?.[1];
          expect(pid(second.body)).toBe(pid(first.body));

          // A child that dies mid-call fails that call at once, not at a deadline, and the next
          // call starts the command again.
          const crashed = yield* callTool("crash", {}).pipe(Effect.timed);
          expect(crashed[1].status).not.toBe(200);
          expect(Duration.toMillis(crashed[0])).toBeLessThan(20_000);
          const revived = yield* call("Ada");
          expect(revived.status, revived.body).toBe(200);
          expect(pid(revived.body)).not.toBe(pid(first.body));

          // The app's endpoint account is the host's one account for it.
          const endpointAccounts = Effect.gen(function* () {
            const response = yield* http.execute(
              HttpClientRequest.get(`${cli.url}/v1/accounts?owner=local`).pipe(
                HttpClientRequest.bearerToken(Redacted.value((yield* cli.registered).password)),
              ),
            );
            const body = (yield* response.json) as
              | ReadonlyArray<{ readonly label?: string }>
              | { readonly accounts: ReadonlyArray<{ readonly label?: string }> };
            const accounts = Array.isArray(body) ? body : "accounts" in body ? body.accounts : [];
            return accounts.filter((account) => account.label === "Greeter endpoint").length;
          });
          expect(yield* endpointAccounts).toBe(1);
          // Its endpoint provider is the server's own, so no other app's endpoint account can
          // fill this app's requirement, nor this one another's.
          const declared = yield* http.execute(
            HttpClientRequest.get(`${cli.url}/v1/apps/${app}?owner=local`).pipe(
              HttpClientRequest.bearerToken(Redacted.value((yield* cli.registered).password)),
            ),
          );
          const requirement = Schema.decodeUnknownSync(
            Schema.Struct({
              requirements: Schema.Struct({
                accounts: Schema.Record(
                  Schema.String,
                  Schema.Struct({ definition: Schema.Struct({ name: Schema.String }) }),
                ),
              }),
            }),
          )(yield* declared.json).requirements.accounts.bridge;
          expect(requirement?.definition.name).toMatch(/^Greeter endpoint \([0-9a-f]{8}\)$/);

          // The command is kept by the local server beside its data, not in the app's source.
          const registryText = yield* fs.readFileString(path.join(cli.data, "stdio-mcp.json"));
          const registry = Schema.decodeUnknownSync(Schema.fromJsonString(Registry))(registryText);
          const servers = Object.values(registry.servers);
          expect(servers).toHaveLength(1);
          expect(servers[0]).toMatchObject({ app, command: runtime });
          const endpoint = `${cli.url}/stdio-mcp/${servers[0]?.id}/mcp`;
          const probe = (request: HttpClientRequest.HttpClientRequest) =>
            http.execute(request).pipe(Effect.map((response) => response.status));
          const initialize = HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
            HttpClientRequest.bodyJsonUnsafe({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "e2e", version: "1.0.0" },
              },
            }),
          );
          // Not even the service's own password opens it: only the app's own token does.
          expect(yield* probe(initialize)).toBe(401);
          expect(
            yield* probe(
              initialize.pipe(HttpClientRequest.bearerToken(Redacted.value(registration.password))),
            ),
          ).toBe(401);
          // A browser page is refused before anything else is checked.
          expect(
            yield* probe(
              initialize.pipe(HttpClientRequest.setHeader("origin", "http://evil.test")),
            ),
          ).toBe(403);

          // Importing again keeps the same app and its one server.
          const again = yield* cli.run(["import-v1", "--from", v1, "--json"], shell);
          expect(again.code, again.stderr).toBe(0);
          const rerun = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(again.stdout);
          expect(rerun.workspaces).toEqual(report.workspaces);
          const after = Schema.decodeUnknownSync(Schema.fromJsonString(Registry))(
            yield* fs.readFileString(path.join(cli.data, "stdio-mcp.json")),
          );
          expect(Object.values(after.servers)).toHaveLength(1);

          // Stopping the service ends the command it started.
          const child = Number(pid(revived.body));
          const running = (processId = child) =>
            Effect.sync(() => {
              try {
                process.kill(processId, 0);
                return true;
              } catch {
                return false;
              }
            });
          const stopped = yield* cli.run(["service", "stop"]);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect(
            yield* running().pipe(
              Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced("100 millis") }),
              Effect.timeout("5 seconds"),
            ),
          ).toBe(false);

          // Starting again refreshes the endpoint account rather than adding one, and the app
          // reaches its command through it.
          const restarted = yield* cli.run(["service", "start"]);
          expect(restarted.code, restarted.stderr).toBe(0);
          expect(yield* endpointAccounts).toBe(1);
          const afterRestart = yield* call("Ada");
          expect(afterRestart.status, afterRestart.body).toBe(200);

          // Deleting the app stops its running server at once, and forgets it with its endpoint
          // account, without restarting the service.
          const removed = yield* http.execute(
            HttpClientRequest.delete(`${cli.url}/v1/apps/${app}?owner=local`).pipe(
              HttpClientRequest.bearerToken(Redacted.value((yield* cli.registered).password)),
            ),
          );
          expect(removed.status).toBeLessThan(300);
          expect(
            yield* running(Number(pid(afterRestart.body))).pipe(
              Effect.repeat({ while: (alive) => alive, schedule: Schedule.spaced("100 millis") }),
              Effect.timeout("5 seconds"),
            ),
          ).toBe(false);
          const forgotten = Schema.decodeUnknownSync(Schema.fromJsonString(Registry))(
            yield* fs.readFileString(path.join(cli.data, "stdio-mcp.json")),
          );
          expect(forgotten.servers).toEqual({});
          expect(yield* endpointAccounts).toBe(0);
          expect((yield* cli.run(["service", "stop"])).code).toBe(0);
        }),
      ),
    // The import builds the app in the background Executor before its tool is called.
    { timeout: 300_000 },
  );
});
