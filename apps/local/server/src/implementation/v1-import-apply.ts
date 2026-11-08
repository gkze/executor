/**
 * Import a local Executor 1 workspace into this Executor, in the background Executor that owns its
 * data. Each integration becomes the app the shared v1 import generates, with Executor 1's tool
 * policies as its approval rules; each connection an account holding its `auth.json` credential,
 * linked for the person; and fixed credentials in an integration's configuration one more account.
 *
 * A record in the data directory (`v1-import.json`) says what each item became, so running the
 * import again moves only what has not moved. Before each app or account is made, the record
 * notes that it is being made, so a run interrupted between making it and recording it finds it
 * again instead of making a second one.
 */
import { createHash } from "node:crypto";
import {
  accountLabel,
  accountRequirement,
  accountWrite,
  buildFailed,
  copiedGrantTokens,
  createNamed,
  fixedAccount,
  fixedRequirement,
  grantRefusals,
  integrationLabel,
  integrationNaming,
  needsNoAccount,
  personalRequirement,
  readSecret,
  connectionPlan,
  appNames,
  type AppAccounts,
  type ConnectionRow,
  type IntegrationRow,
} from "@executor-js/v1-import";
import { itemFailed } from "@executor-js/v1-import/contracts";
import {
  AccountId,
  AppId,
  OAuthGrantImport,
  type Account,
  type App,
  type Executor,
  type SourceFiles,
} from "@executor-js/sdk/core";
import { Clock, Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect";
import type { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import { fetchSpecification } from "@executor-js/v1-import";
import {
  V1ImportFailed,
  type V1ImportBatch,
  type V1ImportItem,
  type V1ImportRequest,
} from "../contracts/v1-import.ts";
import { linkAccount, linkedAccounts } from "./app-accounts.ts";
import { writeAtomically } from "./atomic-file.ts";
import { localOwner } from "./owners.ts";
import {
  followIntegration,
  generateApp,
  localProduct,
  openV1,
  planConnection,
  planIntegration,
  policyOutcome,
  settle,
  type IntegrationResult,
  type V1Workspace,
} from "./v1-import.ts";

/** An app or account being made: when its making started, in milliseconds since the epoch. */
const Pending = Schema.Struct({ pending: Schema.Number });

/**
 * An app the import made. `version` is the version it deployed last and `source` the hash of that
 * version's generated files; both are absent for an app recorded before they were.
 */
const MadeApp = Schema.Struct({
  app: Schema.String,
  version: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
});

/** A fixed-credentials account and the provider it was saved for. */
const MadeFixed = Schema.Struct({ account: Schema.String, provider: Schema.String });

/** What each Executor 1 item became, per workspace, by v1 row id. A bare id is an earlier run's. */
const Ledger = Schema.Struct({
  workspaces: Schema.Record(
    Schema.String,
    Schema.Struct({
      apps: Schema.Record(Schema.String, Schema.Union([Schema.String, MadeApp, Pending])),
      accounts: Schema.Record(Schema.String, Schema.Union([Schema.String, Pending])),
      fixed: Schema.Record(Schema.String, Schema.Union([Schema.String, MadeFixed, Pending])),
    }),
  ),
});
type Ledger = typeof Ledger.Type;
type Entries = Ledger["workspaces"][string];
type Recorded = { -readonly [K in keyof Entries]: Record<string, Entries[K][string]> };

const ledgerFile = "v1-import.json";

const isPending = (entry: unknown): entry is typeof Pending.Type =>
  typeof entry === "object" && entry !== null && "pending" in entry;

/**
 * What a rerun does with the app an earlier run made, from what the record says the import
 * deployed and what the app runs now:
 *
 * - `create`: there is none, or it was removed; the import makes one.
 * - `unchanged`: it runs the import's version, whose source is what the rows generate now.
 * - `update`: it runs the import's version, and the rows now generate other source; the import
 *   deploys that as a new version.
 * - `kept`: it runs a version the import did not deploy, such as the person's own edit, or one
 *   recorded before versions were. The import never replaces it.
 */
const rerunDecision = (
  recorded: typeof MadeApp.Type | undefined,
  app: Pick<App, "activeVersion"> | undefined,
  source: string,
): "create" | "unchanged" | "update" | "kept" =>
  recorded === undefined || app === undefined
    ? "create"
    : recorded.version === undefined || app.activeVersion !== recorded.version
      ? "kept"
      : recorded.source === source
        ? "unchanged"
        : "update";

/** The hash a version's generated files are recorded under. */
const sourceHash = (files: SourceFiles) =>
  createHash("sha256").update(JSON.stringify(files)).digest("hex");

/** The background Executor's import: one request at a time, each a few integrations. */
export const makeV1Import = (input: {
  readonly executor: Executor;
  readonly sql: SqlClient.SqlClient;
  readonly directory: string;
  readonly platform: string;
  readonly http: HttpClient.HttpClient;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { executor, sql } = input;
    const file = path.join(input.directory, ledgerFile);
    const lock = yield* Semaphore.make(1);

    const readLedger = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return { workspaces: {} } satisfies Ledger;
      const text = yield* fs.readFileString(file);
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger))(text);
    }).pipe(Effect.mapError(() => new V1ImportFailed({ problem: "unreadable_record" })));

    /** The workspace's entries, saved after every change so an interruption keeps what moved. */
    const ledgerFor = (tenant: string) =>
      Effect.gen(function* () {
        const ledger = yield* readLedger;
        const recorded: Recorded = {
          apps: { ...ledger.workspaces[tenant]?.apps },
          accounts: { ...ledger.workspaces[tenant]?.accounts },
          fixed: { ...ledger.workspaces[tenant]?.fixed },
        };
        const save = Effect.gen(function* () {
          const current = yield* readLedger;
          const next: Ledger = { workspaces: { ...current.workspaces, [tenant]: recorded } };
          yield* writeAtomically(
            input.platform,
            input.directory,
            file,
            `${JSON.stringify(next, null, 2)}\n`,
          ).pipe(Effect.mapError(() => new V1ImportFailed({ problem: "unwritable_record" })));
        });
        /** Note that the entry is being made, before making it. */
        const begin = (kind: keyof Recorded, id: string) =>
          Effect.gen(function* () {
            Object.assign(recorded[kind], { [id]: { pending: yield* Clock.currentTimeMillis } });
            yield* save;
          });
        const record = <K extends keyof Recorded>(
          kind: K,
          id: string,
          entry: Recorded[K][string],
        ) =>
          Effect.suspend(() => {
            Object.assign(recorded[kind], { [id]: entry });
            return save;
          });
        return { recorded, begin, record };
      });
    type LedgerOf = Effect.Success<ReturnType<typeof ledgerFor>>;

    const appOf = (id: string) =>
      executor.apps
        .get({ app: AppId.make(id) })
        .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
    const accountOf = (id: string) =>
      executor.accounts
        .get({ owner: localOwner, account: AccountId.make(id) })
        .pipe(Effect.catchTag("AccountNotFound", () => Effect.succeed(undefined)));

    /**
     * The app an interrupted run was making for an integration: one of its names, made after the
     * run noted it was making it.
     */
    const madeApp = (integration: IntegrationRow, since: number) =>
      executor.apps.list().pipe(
        Effect.map((apps) => {
          const names = new Set(appNames(integrationNaming(integration)));
          return apps.find(
            (app) =>
              app.owner === localOwner && names.has(app.name) && app.createdAt.getTime() >= since,
          );
        }),
      );

    /** The account an interrupted run was making: its label and provider, made since then. */
    const madeAccount = (provider: Account["provider"], label: string, since: number) =>
      executor.accounts
        .list({ owner: localOwner, provider })
        .pipe(
          Effect.map((accounts) =>
            accounts.find(
              (account) => account.label === label && account.createdAt.getTime() >= since,
            ),
          ),
        );

    /** The app the record names for an integration, adopting one an interrupted run made. */
    const recordedApp = (ledger: LedgerOf, integration: IntegrationRow) =>
      Effect.gen(function* () {
        const entry = ledger.recorded.apps[integration.row_id];
        if (entry === undefined) return undefined;
        if (isPending(entry)) {
          const made = yield* madeApp(integration, entry.pending);
          if (made === undefined) return undefined;
          // The run stopped before it could say so. The import deployed the app's first version,
          // so that version is the import's own only while it is still the only one; a later one
          // is the person's, and recording no version keeps it.
          const versions = yield* executor.apps.versions({ app: made.id });
          const own =
            made.activeVersion !== null &&
            versions.length === 1 &&
            versions[0]?.id === made.activeVersion;
          const adopted = { app: made.id, ...(own ? { version: made.activeVersion } : {}) };
          yield* ledger.record("apps", integration.row_id, adopted);
          return { recorded: adopted, app: made };
        }
        const recorded = typeof entry === "string" ? { app: entry } : entry;
        return { recorded, app: yield* appOf(recorded.app) };
      });

    /** Make the integration's app under its first free name, noting it first. */
    const createApp = (ledger: LedgerOf, integration: IntegrationRow, files: SourceFiles) =>
      Effect.gen(function* () {
        yield* ledger.begin("apps", integration.row_id);
        return yield* createNamed(localProduct, integrationNaming(integration), (name) =>
          executor.apps.deploy({ owner: localOwner, name, files }),
        ).pipe(Effect.map((deployed) => deployed.app));
      });

    /**
     * The integration's app, decided by `rerunDecision`. A new version that would take another
     * provider's accounts than the ones linked to the app is not deployed: those accounts would no
     * longer fit it.
     */
    const ensureApp = (workspace: V1Workspace, integration: IntegrationRow, ledger: LedgerOf) =>
      Effect.gen(function* () {
        const generated = yield* generateApp(workspace, integration);
        const { files, note } = generated.generated;
        const source = sourceHash(files);
        const earlier = yield* recordedApp(ledger, integration);
        const decision = rerunDecision(earlier?.recorded, earlier?.app, source);
        const deployed = yield* Effect.gen(function* () {
          if (decision === "create" || earlier?.app === undefined) {
            const app = yield* createApp(ledger, integration, files);
            yield* ledger.record("apps", integration.row_id, {
              app: app.id,
              version: app.activeVersion,
              source,
            });
            return { app, notes: [note] };
          }
          const app = earlier.app;
          if (decision === "unchanged") return { app, notes: [note] };
          if (decision === "kept")
            return {
              app,
              notes: [
                "It keeps the version it runs now, which the import did not deploy, so the import did not change it.",
              ],
            };
          // The app runs the import's earlier version, which keeps working when the new one cannot
          // replace it.
          const keeps = (why: string) => ({
            app,
            notes: [`Generated again, ${why}, so it keeps the version an earlier import made.`],
          });
          const built = yield* executor.apps
            .build({ owner: localOwner, name: integrationLabel(integration), files })
            .pipe(Effect.result);
          if (built._tag === "Failure")
            return built.failure._tag === "VersionBuildFailed"
              ? keeps("it did not build")
              : yield* Effect.fail(built.failure);
          const provider = (requirements: App["requirements"]) =>
            requirements.accounts[personalRequirement]?.provider;
          if (
            provider(built.success.requirements) !== provider(app.requirements) &&
            (yield* linkedAccounts(sql, executor, app)).length > 0
          )
            return keeps("it would take other accounts than the ones linked to it");
          const next = (yield* executor.apps.deploy({ owner: localOwner, app: app.id, files })).app;
          yield* ledger.record("apps", integration.row_id, {
            app: next.id,
            version: next.activeVersion,
            source,
          });
          return { app: next, notes: [note] };
        });
        const text = deployed.notes.filter((part) => part !== undefined).join(" ");
        return {
          app: deployed.app,
          planned: generated.planned,
          ...(text === "" ? {} : { note: text }),
        };
      }).pipe(Effect.catchTag("VersionBuildFailed", (error) => Effect.fail(buildFailed(error))));

    /**
     * The account holding the integration's fixed credentials, when its app takes one, linked for
     * the app. One saved for another provider no longer fits it, so another is saved.
     */
    const ensureFixed = (
      ledger: LedgerOf,
      integration: IntegrationRow,
      app: App,
      planned: AppAccounts,
    ) =>
      Effect.gen(function* () {
        const requirement = app.requirements.accounts[fixedRequirement];
        if (requirement === undefined) return;
        const label = `${integrationLabel(integration)} fixed credentials`;
        const entry = ledger.recorded.fixed[integration.row_id];
        const recorded =
          entry === undefined || isPending(entry)
            ? undefined
            : typeof entry === "string"
              ? { account: entry, provider: requirement.provider }
              : entry;
        const kept =
          recorded !== undefined && recorded.provider === requirement.provider
            ? yield* accountOf(recorded.account)
            : isPending(entry)
              ? yield* madeAccount(requirement.provider, label, entry.pending)
              : undefined;
        const account =
          kept ??
          (yield* Effect.gen(function* () {
            yield* ledger.begin("fixed", integration.row_id);
            return yield* executor.managedAccounts.add({
              owner: localOwner,
              provider: requirement.provider,
              method: fixedRequirement,
              label,
              fields: (yield* fixedAccount(planned)).values,
            });
          }));
        yield* ledger.record("fixed", integration.row_id, {
          account: account.id,
          provider: requirement.provider,
        });
        yield* linkAccount(sql, executor, {
          app: app.id,
          scope: "app",
          requirement: fixedRequirement,
          account: account.id,
        });
      });

    /**
     * The connection's account, linked to its integration's app for the person: the record's,
     * given Executor 1's newer tokens if it renewed its grant since, or a new one from `auth.json`.
     */
    const ensureAccount = (
      workspace: V1Workspace,
      ledger: LedgerOf,
      row: ConnectionRow,
      app: Pick<App, "id" | "requirements">,
    ) =>
      Effect.gen(function* () {
        const context = {
          product: localProduct,
          snapshot: workspace.rows,
          source: workspace.reader,
        };
        const plan = connectionPlan(localProduct, workspace.rows, row);
        if (!plan.ok) return yield* itemFailed(plan.reason);
        const accounts = app.requirements.accounts;
        if (needsNoAccount(plan.value, accounts)) return undefined;
        const requirement = accountRequirement(localProduct, row);
        const entry = ledger.recorded.accounts[row.row_id];
        const earlier =
          typeof entry === "string"
            ? yield* accountOf(entry)
            : isPending(entry) && accounts[requirement] !== undefined
              ? yield* madeAccount(
                  accounts[requirement].provider,
                  accountLabel(workspace.rows, row),
                  entry.pending,
                )
              : undefined;
        if (earlier !== undefined) {
          const tokens = yield* copiedGrantTokens(context, plan.value);
          if (tokens !== undefined)
            yield* executor[OAuthGrantImport].refreshImportedGrant(earlier.id, tokens);
        }
        const account =
          earlier ??
          (yield* Effect.gen(function* () {
            const write = yield* accountWrite({
              context,
              plan: plan.value,
              accounts,
              owner: localOwner,
              secret: (itemId) => readSecret(context, row, itemId),
              scope: "integration",
            });
            yield* ledger.begin("accounts", row.row_id);
            return write.kind === "fields"
              ? yield* executor.managedAccounts.add(write.input)
              : yield* executor[OAuthGrantImport]
                  .importOAuthGrant(write.input)
                  .pipe(grantRefusals(localProduct, write));
          }));
        yield* ledger.record("accounts", row.row_id, account.id);
        yield* linkAccount(sql, executor, {
          app: app.id,
          scope: "user",
          requirement,
          account: account.id,
        });
        return account.id;
      });

    /** Import one integration and its connections, reporting each. */
    const importIntegration = (
      workspace: V1Workspace,
      ledger: LedgerOf,
      integration: IntegrationRow,
    ) =>
      Effect.gen(function* () {
        const planned = planIntegration(integration);
        const connections = workspace.rows.connections
          .filter((row) => row.integration === integration.slug)
          .map((row) => ({ row, item: planConnection(workspace, row) }));
        const result = (item: V1ImportItem): IntegrationResult => ({
          outcome: item.outcome,
          reason: item.reason,
        });
        const gone = (item: V1ImportItem) => [
          item,
          ...connections.map((connection) => followIntegration(connection.item, result(item))),
        ];
        if (planned.outcome !== "moves") return { result: result(planned), items: gone(planned) };
        const app = yield* settle(ensureApp(workspace, integration, ledger));
        if (!app.ok) {
          const refusedItem = { ...planned, ...app.decided };
          return { result: result(refusedItem), items: gone(refusedItem) };
        }
        const made = app.value;
        const item: V1ImportItem = {
          ...planned,
          v2Id: made.app.id,
          ...(made.note === undefined ? {} : { note: made.note }),
        };
        const items: V1ImportItem[] = [item];
        const fixed = yield* settle(ensureFixed(ledger, integration, made.app, made.planned));
        for (const { row, item: connection } of connections) {
          if (connection.outcome !== "moves") {
            items.push(connection);
            continue;
          }
          const account = yield* settle(ensureAccount(workspace, ledger, row, made.app));
          items.push(
            account.ok
              ? { ...connection, ...(account.value === undefined ? {} : { v2Id: account.value }) }
              : { ...connection, ...account.decided },
          );
        }
        if (!fixed.ok)
          items[0] = {
            ...item,
            outcome: fixed.decided.outcome,
            reason:
              `Its fixed credentials' account was not saved. ${fixed.decided.reason ?? ""}`.trim(),
          };
        return { result: result(item), items };
      });

    /** Import the request's integrations, their connections and the policies naming them. */
    const run = (request: V1ImportRequest) =>
      lock.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const [workspace] = yield* openV1(request.from, Option.some(request.workspace), (url) =>
              fetchSpecification(input.http, url),
            );
            if (workspace === undefined) return { items: [] } satisfies V1ImportBatch;
            const ledger = yield* ledgerFor(workspace.rows.tenant);
            const results = new Map<string, IntegrationResult>();
            const items: V1ImportItem[] = [];
            for (const slug of request.integrations) {
              const integration = workspace.rows.integrations.find((row) => row.slug === slug);
              // Removed from Executor 1 since the command read it.
              if (integration === undefined) {
                items.push({
                  kind: "integration",
                  id: slug,
                  label: slug,
                  integration: null,
                  outcome: "skipped",
                  reason: "It no longer exists in Executor 1.",
                });
                continue;
              }
              const imported = yield* importIntegration(workspace, ledger, integration);
              results.set(slug, imported.result);
              items.push(...imported.items);
            }
            for (const row of workspace.rows.policies) {
              const policy = policyOutcome(workspace.rows, row, results);
              if (policy !== undefined) items.push(policy);
            }
            return { items } satisfies V1ImportBatch;
          }),
        ),
      );

    return { run };
  });
