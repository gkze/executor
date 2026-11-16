/**
 * The local server runs a stdio MCP server for an app and serves it at a bridge URL that only the
 * app's account can use. Each call opens its own MCP session, as apps do, and every session shares
 * one child process. The child sees the server's plain variables and the account's secret ones and
 * none of the server's own, a child that exits is replaced by the next call, and a child's question
 * reaches the caller whose tool call asked it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Target } from "../support/platform.ts";
import { stdioMcpUpstreamSource } from "../support/stdio-mcp-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Created = Schema.Struct({
  app: Schema.Struct({ id: Schema.String, slug: Schema.String }),
  account: Schema.String,
});
const InputRequired = Schema.Struct({
  status: Schema.Literal("input-required"),
  requestId: Schema.String,
  elicitation: Schema.Struct({ message: Schema.String }),
});
const Resumed = Schema.Struct({ status: Schema.Literal("completed"), execution: Schema.Unknown });
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});
const Report = Schema.Struct({
  pid: Schema.Number,
  calls: Schema.Number,
  plain: Schema.NullOr(Schema.String),
  secret: Schema.NullOr(Schema.String),
  executorKeys: Schema.Array(Schema.String),
});
const Crashed = Schema.Struct({
  _tag: Schema.Literal("ToolCallFailed"),
  mcp: Schema.Struct({
    phase: Schema.Literal("call"),
    upstream: Schema.Struct({ code: Schema.Number, message: Schema.String }),
  }),
});
const Completed = Schema.Struct({
  status: Schema.Literal("completed"),
  value: Schema.Struct({ structuredContent: Report }),
});

layer(TestLive, { excludeTestServices: true })("Local stdio MCP", (it) => {
  it.effect(scenarios.localStdioMcp.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const session = yield* api.session();
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-stdio-mcp-" });
        const upstream = path.join(directory, "upstream.mjs");
        yield* fs.writeFileString(upstream, stdioMcpUpstreamSource);
        // The local API takes the host-issued bearer credential, not a browser origin.
        const agent: Session = {
          ...session,
          send: (method, path, data, headers = {}) => {
            const { origin: _origin, ...agentHeaders } = headers;
            return session.send(method, path, data, {
              ...agentHeaders,
              authorization: `Bearer ${Redacted.value(target.apiKey)}`,
            });
          },
        };
        const created = yield* api.request(agent, "POST", "/v1/stdio-mcp-servers", {
          name: `Stdio fixture ${randomUUID().slice(0, 8)}`,
          command: process.execPath,
          args: [upstream],
          env: { FIXTURE_PLAIN: "plain value" },
          secrets: { FIXTURE_SECRET: "secret value" },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const { app, account } = yield* body(Created, created);
        // Remove the app before the account linked to it.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            expect((yield* api.request(agent, "DELETE", `/v1/apps/${app.id}`)).status).toBe(200);
            expect((yield* api.request(agent, "DELETE", `/v1/accounts/${account}`)).status).toBe(
              200,
            );
          }).pipe(Effect.orDie),
        );

        // The app's source names only the bridge URL; the command stays with the server.
        const source = yield* body(
          Source,
          yield* api.request(agent, "GET", `/v1/apps/${app.id}/source`),
        );
        const provider = source.files.find((file) => file.path === "provider.ts")?.content ?? "";
        const bridge = /export const url = "([^"]+)"/u.exec(provider)?.[1];
        if (bridge === undefined) return yield* Effect.die("The app names no bridge URL");
        expect(new URL(bridge).pathname).toMatch(/^\/stdio-mcp\/stdio_[0-9a-f]{32}$/u);
        expect(source.files.map((file) => file.content).join("\n")).not.toContain(upstream);

        // Without the account's token the bridge refuses, and a browser page may never call it.
        const initialize = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "e2e", version: "1" },
          },
        };
        const accept = { accept: "application/json, text/event-stream" };
        const bridgePath = new URL(bridge).pathname;
        // `send` adds no origin; `api.request` adds the browser's.
        expect((yield* session.send("POST", bridgePath, initialize, accept)).status).toBe(401);
        // The local API key is not the bridge token either.
        expect((yield* agent.send("POST", bridgePath, initialize, accept)).status).toBe(401);
        const fromBrowser = yield* session.send("POST", bridgePath, initialize, {
          ...accept,
          origin: new URL(bridge).origin,
        });
        expect(fromBrowser.status).toBe(403);

        const request = (tool: "report" | "exit") =>
          api.request(agent, "POST", "/v1/tools/call", {
            app: app.id,
            tool,
            // The app's tools take the account to use, as every app with accounts does.
            input: { accountId: account, input: {} },
          });
        const call = (tool: "report") =>
          Effect.gen(function* () {
            const response = yield* request(tool);
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            return (yield* body(Completed, response)).value.structuredContent;
          });

        const first = yield* call("report");
        expect(first.plain).toBe("plain value");
        expect(first.secret).toBe("secret value");
        expect(first.executorKeys).toEqual([]);
        // Later calls, at once and one after another, each open a session on the same child.
        const concurrent = yield* Effect.forEach([1, 2, 3, 4], () => call("report"), {
          concurrency: "unbounded",
        });
        const after = yield* call("report");
        expect(new Set([first, ...concurrent, after].map((report) => report.pid))).toEqual(
          new Set([first.pid]),
        );
        expect(after.calls).toBe(first.calls + concurrent.length + 1);

        // A child that exits fails the call it was serving at once with the closed connection,
        // not by the call's deadline. The bridge drops the child before that call answers, so the
        // next call starts a new one.
        const exited = yield* request("exit");
        expect(
          Schema.is(Crashed)(exited.body) ? exited.body.mcp.upstream : exited.body,
          JSON.stringify(exited.body),
        ).toEqual({ code: -32603, message: "Connection closed" });
        const replaced = yield* call("report");
        expect(replaced.pid).not.toBe(first.pid);
        expect(replaced.calls).toBe(1);
        expect(replaced.secret).toBe("secret value");

        // The child's question reaches the agent whose call asked it, and the answer reaches the
        // child, through local MCP in model mode.
        const mcp = yield* McpClient;
        const client = yield* mcp.connect(target.apiKey, "local-stdio-mcp", { mode: "model" });
        const tool = (step: string, name: "execute" | "resume", args: Record<string, unknown>) =>
          client
            .use(step, (client, signal) =>
              client.callTool({ name, arguments: args }, undefined, { signal }),
            )
            .pipe(
              Effect.tap((result) =>
                Effect.sync(() =>
                  expect(result.isError, JSON.stringify(result.content)).not.toBe(true),
                ),
              ),
              Effect.map((result) => result.structuredContent),
            );
        const asked = yield* tool("Call the tool that asks a question", "execute", {
          code: `return await tools[${JSON.stringify(app.slug)}].ask(${JSON.stringify({ accountId: account, input: {} })});`,
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InputRequired)));
        expect(asked.elicitation.message).toBe("Pick a colour");
        const answered = yield* tool("Answer the question", "resume", {
          requestId: asked.requestId,
          response: { action: "accept", content: { colour: "teal" } },
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Resumed)));
        expect(JSON.stringify(answered.execution)).toContain('"colour":"teal"');
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
