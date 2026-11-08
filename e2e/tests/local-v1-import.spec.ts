/**
 * `executor import-v1` through the real CLI and background Executor. `--dry-run` reads a local
 * Executor 1 data directory and reports what each integration, connection and tool policy becomes,
 * writing nothing: Executor 1's files stay byte for byte, no Executor 2 data directory appears,
 * and no saved credential reaches its output. An import reports what the background Executor
 * answered for each item, and a rerun never replaces a version the person deployed.
 */
import { createHash } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Option, Path, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { backgroundServiceCli } from "../support/background-service.ts";
import { localEntryCommand } from "../support/local-entry.ts";
import { type V1LocalData, writeV1LocalData, writeV1Policies } from "../support/v1-local-data.ts";

const work = "work-1a2b3c4d";
const other = "other-9f8e7d6c";
/** Credential values that must never be printed. */
const notesToken = "v1-notes-token-7f3a91";
const linearToken = "v1-linear-token-c04e2b";
const petsToken = "v1-pets-token-5d17e0";
const calendarAccess = "v1-calendar-access-91c2aa";
const calendarRefresh = "v1-calendar-refresh-0e44b7";
const calendarSecret = "v1-calendar-client-secret-3f80d1";
const secrets = [
  notesToken,
  linearToken,
  petsToken,
  calendarAccess,
  calendarRefresh,
  calendarSecret,
];

const calendarAuth = "https://auth.calendar.example.test";

const remoteMcp = (endpoint: string) => ({
  transport: "remote",
  endpoint,
  remoteTransport: "streamable-http",
  authenticationTemplate: [
    {
      slug: "token",
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    },
  ],
});

/** Executor 1's two workspaces, with one item of each outcome. */
const fixture: V1LocalData = {
  integrations: [
    // Its only connection kept its credential in 1Password, so none moves.
    {
      tenant: work,
      slug: "vaultOnlyMcp",
      plugin: "mcp",
      name: "Vault Only MCP",
      // An identifier v1 sent with every request, which reads like a credential.
      config: {
        ...remoteMcp("https://vault-only.example.test/mcp"),
        headers: { "x-org-id": "org-6a1c0e9f2b7d4c3a8e5f1b0d9c2a7e4f" },
      },
    },
    {
      tenant: work,
      slug: "petStore",
      plugin: "openapi",
      name: "Pet Store",
      config: {
        specHash: "pets-1",
        authenticationTemplate: [
          {
            slug: "key",
            kind: "apikey",
            placements: [{ carrier: "header", name: "x-api-key" }],
          },
        ],
      },
    },
    {
      tenant: work,
      slug: "notesMcp",
      plugin: "mcp",
      name: "Notes MCP",
      config: remoteMcp("https://notes.example.test/mcp"),
    },
    {
      tenant: work,
      slug: "shell",
      plugin: "mcp",
      name: "Shell MCP",
      config: { transport: "stdio", command: "shell-mcp", args: [] },
    },
    {
      tenant: work,
      slug: "petsApi",
      plugin: "openapi",
      name: "Pets API",
      // v1 never resolved its specification.
      config: { baseUrl: "https://pets.example.test" },
    },
    // Its connection signed in through a workspace OAuth client.
    {
      tenant: work,
      slug: "calendarApi",
      plugin: "openapi",
      name: "Calendar API",
      config: {
        specHash: "calendar-1",
        authenticationTemplate: [
          {
            slug: "oauth",
            kind: "oauth2",
            authorizationUrl: `${calendarAuth}/authorize`,
            tokenUrl: `${calendarAuth}/token`,
            scopes: ["events.read"],
          },
        ],
      },
    },
    {
      tenant: other,
      slug: "linearMcp",
      plugin: "mcp",
      name: "Linear MCP",
      config: remoteMcp("https://linear.example.test/mcp"),
    },
  ],
  connections: [
    {
      tenant: work,
      rowId: "conn_vault_only",
      integration: "vaultOnlyMcp",
      name: "default",
      template: "token",
      provider: "onepassword",
      items: { token: "op://Private/VaultOnly/credential" },
    },
    {
      tenant: work,
      rowId: "conn_pets",
      integration: "petStore",
      name: "pets",
      template: "key",
      provider: "file",
      items: { token: "work:org:pets:token" },
    },
    {
      tenant: work,
      rowId: "conn_saved",
      integration: "notesMcp",
      name: "work",
      template: "token",
      provider: "file",
      items: { token: "work:org:notes:token" },
    },
    {
      tenant: work,
      rowId: "conn_lost",
      integration: "notesMcp",
      name: "lost",
      template: "token",
      provider: "file",
      items: { token: "work:org:notes-lost:token" },
    },
    {
      tenant: work,
      rowId: "conn_vault",
      integration: "notesMcp",
      name: "vault",
      template: "token",
      provider: "onepassword",
      items: { token: "op://Private/Notes/credential" },
      owner: "user",
    },
    {
      tenant: work,
      rowId: "conn_shell",
      integration: "shell",
      name: "default",
      template: "none",
      provider: "file",
      items: {},
    },
    {
      tenant: work,
      rowId: "conn_calendar",
      integration: "calendarApi",
      name: "calendar",
      template: "oauth",
      provider: "file",
      items: { token: "work:org:calendar:access" },
      oauth: {
        client: "calendar-client",
        refreshItem: "work:org:calendar:refresh",
        expiresAt: 4_102_444_800_000,
        scope: "events.read",
      },
    },
    {
      tenant: other,
      rowId: "conn_linear",
      integration: "linearMcp",
      name: "default",
      template: "token",
      provider: "file",
      items: { token: "other:org:linear:token" },
    },
  ],
  clients: [
    {
      tenant: work,
      slug: "calendar-client",
      authorizationUrl: `${calendarAuth}/authorize`,
      tokenUrl: `${calendarAuth}/token`,
      clientId: "calendar-client-id",
      secretItem: "work:org:calendar:client-secret",
    },
  ],
  policies: [
    // Executor 1 asked before every call of the pet store's listPets.
    {
      tenant: work,
      id: "pets-ask",
      pattern: "petStore.*.*.listPets",
      action: "require_approval",
    },
    {
      tenant: work,
      id: "ask-before-delete",
      pattern: "notesMcp.deleteNote",
      action: "require_approval",
    },
    // Executor 1 asked before the local server's `run`, as for any MCP server.
    {
      tenant: work,
      id: "shell-ask",
      pattern: "shell.*.*.run",
      action: "require_approval",
    },
    // v1 matched only whole segments against `*`, so it never applied this rule.
    {
      tenant: work,
      id: "partial-wildcard",
      pattern: "notesMcp.delete*",
      action: "block",
    },
    { tenant: work, id: "builtin", pattern: "executor.*", action: "block" },
  ],
  openapi: [
    {
      tenant: work,
      integration: "petStore",
      specHash: "pets-1",
      spec: {
        openapi: "3.0.3",
        info: { title: "Pet Store", version: "1.0.0" },
        servers: [{ url: "https://pets.example.test" }],
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { "200": { description: "The pets" } },
            },
          },
        },
      },
      operations: [{ tool: "listPets", method: "get", path: "/pets" }],
    },
    {
      tenant: work,
      integration: "calendarApi",
      specHash: "calendar-1",
      spec: {
        openapi: "3.0.3",
        info: { title: "Calendar", version: "1.0.0" },
        servers: [{ url: "https://calendar.example.test" }],
        paths: {
          "/events": {
            get: {
              operationId: "listEvents",
              responses: { "200": { description: "The events" } },
            },
          },
        },
      },
      operations: [{ tool: "listEvents", method: "get", path: "/events" }],
    },
  ],
  credentials: {
    "work:org:pets:token": petsToken,
    "work:org:notes:token": notesToken,
    "work:org:calendar:access": calendarAccess,
    "work:org:calendar:refresh": calendarRefresh,
    "work:org:calendar:client-secret": calendarSecret,
    "other:org:linear:token": linearToken,
  },
};

/** No saved credential reaches a command's output. */
const printsNoSecret = (result: { readonly stdout: string; readonly stderr: string }) => {
  for (const secret of secrets) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
};

const Report = Schema.Struct({
  from: Schema.String,
  dryRun: Schema.Boolean,
  workspaces: Schema.Array(
    Schema.Struct({
      tenant: Schema.String,
      items: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          id: Schema.String,
          label: Schema.String,
          integration: Schema.NullOr(Schema.String),
          outcome: Schema.String,
          reason: Schema.optionalKey(Schema.String),
          category: Schema.optionalKey(Schema.String),
          v2Id: Schema.optionalKey(Schema.String),
          note: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});

layer(TestLive, { excludeTestServices: true })("Local Executor 1 import", (it) => {
  it.effect(
    scenarios.localV1ImportDryRun.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner,
            evidence = yield* Evidence;
          const packagedEntry = yield* Config.NonEmptyString("EXECUTOR_E2E_LOCAL_ENTRY").pipe(
            Config.option,
          );
          const entry = path.resolve(
            Option.isSome(packagedEntry) ? packagedEntry.value : "apps/local/server/src/bin.ts",
          );
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "executor-v1-import-" });
          const v1 = path.join(home, ".executor");
          const data = path.join(home, "v2-data");

          yield* writeV1LocalData(v1, fixture);

          const digest = (file: string) =>
            fs
              .readFile(path.join(v1, file))
              .pipe(Effect.map((bytes) => createHash("sha256").update(bytes).digest("hex")));
          const before = { db: yield* digest("data.db"), auth: yield* digest("auth.json") };

          const run = (args: ReadonlyArray<string>) =>
            evidence.step(
              `executor ${args.join(" ")}`,
              Effect.scoped(
                Effect.gen(function* () {
                  const command = localEntryCommand(entry, args);
                  const child = yield* processes.spawn(
                    ChildProcess.make(command.command, command.args, {
                      extendEnv: false,
                      env: {
                        PATH: process.env.PATH ?? "",
                        HOME: home,
                        USERPROFILE: home,
                        DO_NOT_TRACK: "1",
                        EXECUTOR_DATA_DIR: data,
                      },
                      stdout: "pipe",
                      stderr: "pipe",
                      forceKillAfter: "3 seconds",
                    }),
                  );
                  const [code, stdout, stderr] = yield* Effect.all(
                    [
                      child.exitCode,
                      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
                    ],
                    { concurrency: 3 },
                  ).pipe(Effect.timeout("30 seconds"));
                  const result = { code: Number(code), stdout, stderr };
                  printsNoSecret(result);
                  return result;
                }),
              ),
            );

          // The default directory is ~/.executor; every workspace is reported.
          const planned = yield* run(["import-v1", "--dry-run", "--json"]);
          yield* evidence.json("dry-run.json", planned);
          expect(planned.code, planned.stderr).toBe(0);
          const report = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(planned.stdout);
          expect(report.from).toBe(v1);
          expect(report.workspaces.map((workspace) => workspace.tenant)).toEqual([other, work]);
          const items = report.workspaces.find((workspace) => workspace.tenant === work)?.items;
          const item = (id: string) => items?.find((candidate) => candidate.id === id);
          expect(item("notesMcp")).toMatchObject({ kind: "integration", outcome: "moves" });
          expect(item("petStore")).toMatchObject({ kind: "integration", outcome: "moves" });
          expect(item("conn_pets")).toMatchObject({ outcome: "moves" });
          expect(item("conn_calendar")).toMatchObject({ outcome: "moves" });
          // A local (stdio) MCP server cannot run here: apps cannot start local processes.
          expect(item("shell")).toMatchObject({
            kind: "integration",
            outcome: "cannot_move",
            category: "local_server",
          });
          expect(item("petsApi")).toMatchObject({
            outcome: "cannot_move",
            reason: "v1 stored no resolved specification for it.",
          });
          expect(item("conn_saved")).toMatchObject({
            kind: "connection",
            label: "Notes MCP / work",
            integration: "Notes MCP",
            outcome: "moves",
          });
          // Its item id is in Executor 1's connection, but auth.json no longer holds it.
          expect(item("conn_lost")).toMatchObject({
            outcome: "skipped",
            category: "missing_credential",
          });
          expect(item("conn_vault")).toMatchObject({ outcome: "reconnect" });
          expect(item("conn_vault")?.reason).toContain("1Password");
          // A connection of an integration that cannot move goes with it.
          expect(item("conn_shell")).toMatchObject({ outcome: "cannot_move" });
          expect(item("ask-before-delete")).toMatchObject({
            kind: "tool_policy",
            integration: "Notes MCP",
            outcome: "moves",
          });
          expect(item("partial-wildcard")).toMatchObject({
            outcome: "skipped",
            reason: "v1 never applied this rule.",
          });
          expect(item("builtin")).toMatchObject({
            outcome: "skipped",
            reason: "It applies to v1's built-in tools, which v2 does not have.",
          });

          // --workspace reports one workspace; an unknown one is refused.
          const one = yield* run(["import-v1", "--dry-run", "--json", "--workspace", other]);
          expect(one.code, one.stderr).toBe(0);
          const only = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(one.stdout);
          expect(only.workspaces).toHaveLength(1);
          expect(only.workspaces[0]?.items).toEqual([
            expect.objectContaining({ id: "linearMcp", outcome: "moves" }),
            expect.objectContaining({ id: "conn_linear", outcome: "moves" }),
          ]);
          const unknown = yield* run(["import-v1", "--dry-run", "--workspace", "missing-00000000"]);
          expect(unknown.code).toBe(1);
          expect(unknown.stderr).toContain("Executor 1's database has no such workspace.");

          // The person's report counts each kind and lists what does not simply move.
          const text = yield* run(["import-v1", "--dry-run", "--from", v1]);
          expect(text.code, text.stderr).toBe(0);
          expect(text.stdout).toContain(`Workspace ${work}`);
          expect(text.stdout).toContain(
            "Connections: 3 move, 2 move without their credential, 1 cannot move, 1 skipped",
          );
          expect(text.stdout).toContain("Notes MCP / vault: Its credential is kept in 1Password");
          expect(text.stdout).toContain("Nothing was written. Run without --dry-run to import.");

          // A directory without Executor 1's database is refused.
          const empty = yield* run(["import-v1", "--dry-run", "--from", home]);
          expect(empty.code).toBe(1);
          expect(empty.stderr).toContain("The directory has no Executor 1 database (data.db).");

          // Executor 1's files are unchanged, and no Executor 2 data directory was created.
          expect({ db: yield* digest("data.db"), auth: yield* digest("auth.json") }).toEqual(
            before,
          );
          expect(yield* fs.exists(data)).toBe(false);
        }),
      ),
    // Each command starts the CLI once; every one has its own timeout.
    { timeout: 180_000 },
  );
  it.effect(
    scenarios.localV1Import.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            http = yield* HttpClient.HttpClient;
          const cli = yield* backgroundServiceCli();
          const v1 = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "executor-v1-" }), "v1");
          yield* writeV1LocalData(v1, fixture);
          const imported = (result: { readonly stdout: string; readonly stderr: string }) => {
            printsNoSecret(result);
            return Schema.decodeUnknownSync(Schema.fromJsonString(Report))(result.stdout);
          };
          const itemsOf = (report: typeof Report.Type, tenant: string) => {
            const items = report.workspaces.find((workspace) => workspace.tenant === tenant)?.items;
            return (id: string) => items?.find((candidate) => candidate.id === id);
          };

          // The import starts the background Executor and sends it each workspace's integrations,
          // a few at a time; every item's outcome is the background Executor's answer.
          const first = yield* cli.run(["import-v1", "--from", v1, "--json"]);
          expect(first.code, first.stderr).toBe(0);
          const report = imported(first);
          expect(report.dryRun).toBe(false);
          const item = itemsOf(report, work);
          for (const id of [
            "petStore",
            "notesMcp",
            "calendarApi",
            "conn_pets",
            "conn_saved",
            "conn_calendar",
          ])
            expect(item(id), id).toMatchObject({ outcome: "moves", v2Id: expect.any(String) });
          expect(item("conn_lost")).toMatchObject({ outcome: "skipped" });
          expect(item("conn_vault")).toMatchObject({ outcome: "reconnect" });
          expect(item("shell")).toMatchObject({ outcome: "cannot_move" });
          expect(item("conn_shell")).toMatchObject({ outcome: "cannot_move" });
          expect(item("petsApi")).toMatchObject({ outcome: "cannot_move" });
          expect(item("pets-ask")).toMatchObject({ outcome: "moves" });
          expect(item("shell-ask")).toMatchObject({ outcome: "cannot_move" });
          const others = report.workspaces.find((workspace) => workspace.tenant === other)?.items;
          expect(others?.map((entry) => entry.outcome)).toEqual(["moves", "moves"]);

          // The apps and accounts are this Executor's own, read through its API.
          const registration = yield* cli.registered;
          const request = (method: "GET" | "POST", route: string, body?: unknown) =>
            http
              .execute(
                (method === "GET"
                  ? HttpClientRequest.get(`${cli.url}${route}`)
                  : HttpClientRequest.post(`${cli.url}${route}`).pipe(
                      HttpClientRequest.bodyJsonUnsafe(body),
                    )
                ).pipe(HttpClientRequest.bearerToken(Redacted.value(registration.password))),
              )
              .pipe(
                Effect.flatMap((response) =>
                  response.json.pipe(Effect.map((json) => ({ status: response.status, json }))),
                ),
              );
          const read = (route: string) => request("GET", route);
          const AppView = Schema.Struct({
            name: Schema.String,
            activeVersion: Schema.String,
            requirements: Schema.Struct({
              accounts: Schema.Record(
                Schema.String,
                Schema.Struct({
                  scope: Schema.String,
                  definition: Schema.Struct({ auth: Schema.Unknown }),
                }),
              ),
            }),
          });
          const appOf = (id: string | undefined) =>
            read(`/v1/apps/${id}`).pipe(
              Effect.map((response) => {
                expect(response.status).toBe(200);
                return Schema.decodeUnknownSync(AppView)(response.json);
              }),
            );
          const versionsOf = (id: string | undefined) =>
            read(`/v1/apps/${id}/versions`).pipe(
              Effect.map((response) => (response.json as readonly unknown[]).length),
            );

          const pets = yield* appOf(item("petStore")?.v2Id);
          expect(pets.name).toBe("Pet Store");
          // Local has no organization, so a workspace connection's account is the person's own:
          // the app takes only the person's accounts, and the inventory lists it as linked for them.
          const petRequirements = Object.values(pets.requirements.accounts);
          expect(petRequirements).toHaveLength(1);
          expect(petRequirements[0]?.scope).toBe("user");
          const overview = yield* read("/dashboard/api/overview");
          expect(overview.status).toBe(200);
          expect((overview.json as { links: unknown[] }).links).toContainEqual({
            app: item("petStore")?.v2Id,
            account: item("conn_pets")?.v2Id,
          });
          const account = yield* read(`/v1/accounts/${item("conn_pets")?.v2Id}?owner=local`);
          expect(account.status).toBe(200);
          expect(account.json).toMatchObject({ label: "pets" });
          expect(JSON.stringify(account.json)).not.toContain(petsToken);
          // The OAuth connection's grant moved: its account is the app's OAuth sign-in.
          const calendar = yield* read(`/v1/accounts/${item("conn_calendar")?.v2Id}?owner=local`);
          expect(calendar.status).toBe(200);
          expect(calendar.json).toMatchObject({ label: "calendar", method: "oauth" });
          expect(JSON.stringify(calendar.json)).not.toContain(calendarAccess);

          // Executor 1's rule became the app's own: its tool asks before it runs, so the call
          // waits for approval instead of reaching the pet store.
          const call = yield* request("POST", "/v1/tools/call", {
            app: item("petStore")?.v2Id,
            tool: "listPets",
            input: { accountId: item("conn_pets")?.v2Id, input: {} },
          });
          expect(call.json).toMatchObject({ status: "approval-required" });

          // An app none of whose connections moved still declares its integration's sign-in
          // method, holding the identifier v1 sent with every request, so its account can be
          // connected afterwards.
          expect(item("vaultOnlyMcp")).toMatchObject({
            outcome: "moves",
            v2Id: expect.any(String),
          });
          expect(item("conn_vault_only")).toMatchObject({ outcome: "reconnect" });
          const vaultOnly = Object.values(
            (yield* appOf(item("vaultOnlyMcp")?.v2Id)).requirements.accounts,
          );
          expect(vaultOnly).toHaveLength(1);
          const methods = vaultOnly[0]?.definition.auth as Record<
            string,
            { readonly fields: { readonly required: readonly string[] } }
          >;
          expect(Object.keys(methods)).toEqual(["token"]);
          expect(methods.token?.fields.required).toHaveLength(2);
          expect(methods.token?.fields.required).toContain("token");

          // The person deploys their own version of the pet store's app, and Executor 1's rules
          // change for it and for Notes MCP after the import.
          const petSource = yield* read(`/v1/apps/${item("petStore")?.v2Id}/source`);
          const petFiles = (petSource.json as { files: { path: string }[] }).files;
          expect(JSON.stringify(petFiles)).not.toContain(petsToken);
          const edited = yield* request("POST", "/v1/apps/deploy", {
            owner: "local",
            app: item("petStore")?.v2Id,
            files: [...petFiles, { path: "NOTES.md", content: "Edited by its person.\n" }],
          });
          expect(edited.status, JSON.stringify(edited.json)).toBe(200);
          const personal = (yield* appOf(item("petStore")?.v2Id)).activeVersion;
          yield* writeV1Policies(v1, [
            { tenant: work, id: "pets-ask", pattern: "petStore.*.*.listPets", action: "block" },
            { tenant: work, id: "notes-search", pattern: "notesMcp.*.*.search", action: "approve" },
          ]);
          const notesVersions = yield* versionsOf(item("notesMcp")?.v2Id);
          const notesActive = (yield* appOf(item("notesMcp")?.v2Id)).activeVersion;
          const linearId = itemsOf(report, other)("linearMcp")?.v2Id;
          const linearVersions = yield* versionsOf(linearId);

          // Running it again makes nothing twice. It keeps the person's version; it gives the
          // import's own version of Notes MCP a new one with the new rule; and an app whose
          // generated source is unchanged gets no new version.
          const again = yield* cli.run(["import-v1", "--from", v1, "--json"]);
          expect(again.code, again.stderr).toBe(0);
          const rerun = imported(again);
          for (const workspace of report.workspaces)
            for (const before of workspace.items.filter((entry) => entry.v2Id !== undefined))
              expect(itemsOf(rerun, workspace.tenant)(before.id), before.id).toMatchObject({
                outcome: "moves",
                v2Id: before.v2Id,
              });
          expect((yield* appOf(item("petStore")?.v2Id)).activeVersion).toBe(personal);
          expect(itemsOf(rerun, work)("petStore")?.note).toContain("did not change it");
          expect(itemsOf(rerun, work)("notes-search")).toMatchObject({ outcome: "moves" });
          expect(yield* versionsOf(item("notesMcp")?.v2Id)).toBe(notesVersions + 1);
          expect((yield* appOf(item("notesMcp")?.v2Id)).activeVersion).not.toBe(notesActive);
          expect(yield* versionsOf(linearId)).toBe(linearVersions);

          // The background Executor answers for what it finds when it runs: an integration
          // Executor 1 no longer has is reported, not moved.
          const vanished = yield* request("POST", "/v1/local/v1-import", {
            from: v1,
            workspace: work,
            integrations: ["removedSince"],
          });
          expect(vanished.status).toBe(200);
          expect((vanished.json as { items: unknown[] }).items).toEqual([
            expect.objectContaining({ id: "removedSince", outcome: "skipped" }),
          ]);

          // A run interrupted after making an app and an account, before recording either, left
          // only its notes that it was making them. The next run finds what that run made instead
          // of making a second app or account.
          const ledgerFile = path.join(cli.data, "v1-import.json");
          const Entries = Schema.Record(Schema.String, Schema.Unknown);
          const Ledger = Schema.Struct({
            workspaces: Schema.Record(
              Schema.String,
              Schema.Struct({ apps: Entries, accounts: Entries, fixed: Entries }),
            ),
          });
          const recorded = Schema.decodeUnknownSync(Schema.fromJsonString(Ledger))(
            yield* fs.readFileString(ledgerFile),
          );
          const linear = itemsOf(report, other);
          const otherEntries = recorded.workspaces[other];
          expect(otherEntries).toBeDefined();
          const appEntry = Object.entries(otherEntries?.apps ?? {}).find(([, entry]) =>
            JSON.stringify(entry).includes(String(linearId)),
          )?.[0];
          const accountEntry = Object.entries(otherEntries?.accounts ?? {}).find(
            ([, entry]) => entry === linear("conn_linear")?.v2Id,
          )?.[0];
          expect(appEntry).toBeDefined();
          expect(accountEntry).toBeDefined();
          // Its notes are older than anything this Executor made.
          yield* fs.writeFileString(
            ledgerFile,
            JSON.stringify({
              workspaces: {
                ...recorded.workspaces,
                [other]: {
                  ...otherEntries,
                  apps: { ...otherEntries?.apps, [String(appEntry)]: { pending: 0 } },
                  accounts: { ...otherEntries?.accounts, [String(accountEntry)]: { pending: 0 } },
                },
              },
            }),
          );
          // Before the next run, the person deploys their own version of the app the interrupted
          // run made. The run that finds the app keeps that version: it is not the import's own.
          const linearSource = yield* read(`/v1/apps/${linearId}/source`);
          const linearEdit = yield* request("POST", "/v1/apps/deploy", {
            owner: "local",
            app: linearId,
            files: [
              ...(linearSource.json as { files: { path: string }[] }).files,
              { path: "NOTES.md", content: "Edited by its person.\n" },
            ],
          });
          expect(linearEdit.status, JSON.stringify(linearEdit.json)).toBe(200);
          const linearPersonal = (yield* appOf(linearId)).activeVersion;
          const appNamesNow = read("/v1/apps").pipe(
            Effect.map((response) =>
              (response.json as ReadonlyArray<{ readonly name: string }>)
                .map((app) => app.name)
                .filter((name) => name.startsWith("Linear MCP")),
            ),
          );
          const accountsBefore = (
            (yield* read("/v1/accounts?owner=local")).json as readonly unknown[]
          ).length;
          const resumed = imported(
            yield* cli.run(["import-v1", "--from", v1, "--workspace", other, "--json"]),
          );
          expect(itemsOf(resumed, other)("linearMcp")).toMatchObject({
            outcome: "moves",
            v2Id: linearId,
          });
          expect(itemsOf(resumed, other)("conn_linear")).toMatchObject({
            outcome: "moves",
            v2Id: linear("conn_linear")?.v2Id,
          });
          expect(yield* appNamesNow).toEqual(["Linear MCP"]);
          expect((yield* appOf(linearId)).activeVersion).toBe(linearPersonal);
          expect(itemsOf(resumed, other)("linearMcp")?.note).toContain("did not change it");
          expect(
            ((yield* read("/v1/accounts?owner=local")).json as readonly unknown[]).length,
          ).toBe(accountsBefore);

          // What moved is recorded beside this Executor's data, without any credential.
          const ledger = yield* fs.readFileString(ledgerFile);
          for (const secret of secrets) expect(ledger).not.toContain(secret);
          expect(ledger).toContain(String(item("petStore")?.v2Id));

          // When the background Executor cannot keep its record, the import stops: the report
          // shows nothing as moved that it did not answer for, and the command fails.
          yield* fs.writeFileString(ledgerFile, "not a record");
          const broken = yield* cli.run(["import-v1", "--from", v1, "--json"]);
          expect(broken.code).toBe(1);
          const stopped = imported(broken);
          for (const workspace of stopped.workspaces)
            for (const entry of workspace.items) expect(entry.outcome, entry.id).not.toBe("moves");
          expect(broken.stderr).toContain("v1-import.json");
          yield* fs.writeFileString(ledgerFile, ledger);

          const stoppedService = yield* cli.run(["service", "stop"]);
          expect(stoppedService.code, stoppedService.stderr).toBe(0);
        }),
      ),
    // The import builds an app per integration in the background Executor.
    { timeout: 300_000 },
  );
});
