/**
 * One v1 item becomes v2 resources: an integration an app shared with everyone, an org connection
 * a shared account linked to its app for everyone and a member's connection their personal account
 * linked for them (decision 9), a policy per-tool approvals inside its integration's app, a toolkit
 * a scoped MCP connection for each member it reaches (decision 11), an artifact an app's source
 * without a version. Each returns the resource it created, or why the item cannot be imported; a
 * defect or storage failure fails the step instead and the item is retried.
 */
import { packageFile } from "@executor-js/app-templates";
import {
  CurrentUserId,
  linkAppAccount,
  linkUserAccount,
  organizationOwner,
  type McpConnectionStore,
  type OrganizationId,
} from "@executor-js/hosted-server";
import {
  ConnectionId,
  type ConnectionApp,
  type ConnectionPolicy,
} from "@executor-js/mcp-auth/connections";
import {
  accountDestination,
  personalAccountCreation,
  sharedAppCreation,
} from "@executor-js/hosted-server/resource-lifecycle";
import {
  AccountId,
  AppId,
  OAuthGrantImport,
  scopeGeneratedPackage,
  SourceFiles,
  StorageHost,
  ToolName,
  type DeployedApp,
  type Executor,
  type VersionBuildFailed,
  type OwnerId,
} from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import {
  accountMethod,
  accountRequirement,
  accountWrite,
  appAccounts,
  type AppAccountRequirements,
  type AppNaming,
  approvalRules,
  type AppScope,
  type ArtifactBinding,
  artifactNaming,
  artifactPlan,
  artifactRepairNote,
  type ArtifactRow,
  buildFailed,
  connectionAppName,
  connectionAppNaming,
  connectionContext,
  type ConnectionPlan,
  connectionPlan,
  type ConnectionRow,
  type ConnectionSnapshot,
  copiedGrantTokens,
  createNamed,
  listedAs,
  type FirstPartyClients,
  fixedAccount,
  fixedRequirement,
  generate,
  grantRefusals,
  grantsNoConnection,
  integrationLabel,
  integrationNaming,
  integrationPlan,
  type IntegrationRow,
  mcpNaming,
  readSecret,
  refused,
  type SecretReader,
  toolActions,
  toolkitAction,
  toolkitConnections,
  type ToolRow,
  type V1ImportProduct,
  type V1Toolkit,
} from "@executor-js/v1-import";
import { itemFailed as fail } from "@executor-js/v1-import/contracts";
import type { V1ImportUnreadable, V1Snapshot, V1Source } from "./source.ts";
import {
  sourceHash,
  toolkitCopyConnectionId,
  toolkitCopyId,
  type ImportStore,
  type MapResult,
} from "./store.ts";

/** v1's OAuth callback; imported clients keep it, and v1's edge forwards it to v2. */
export const v1OAuthCallback = "https://executor.sh/api/oauth/callback";

/** What Cloud's report tells its operators and members to do next. */
export const cloudWording: V1ImportProduct["wording"] = {
  product: "Executor v2",
  destination: "v2",
  signInMethod: "an Executor v2 sign-in method",
  reconnect: "Reconnect it in v2.",
  outage: "Contact support if you need it.",
  namesTaken: "Every name for this app is taken in the organization.",
};

/**
 * What Cloud's import knows beyond v1's rows: v1 Cloud kept every saved credential in WorkOS
 * Vault, and an org connection's account is linked for everyone in the organization (decision 9).
 */
export const cloudProduct = (firstParty: FirstPartyClients): V1ImportProduct => ({
  credentialProvider: "workos-vault",
  firstParty,
  callback: v1OAuthCallback,
  orgAccounts: "shared",
  declaredMethods: false,
  // v1 Cloud never ran one either.
  localServers: {
    runs: false,
    refusal: "Local (stdio) MCP servers do not run in Executor Cloud.",
  },
  wording: cloudWording,
});

export interface ItemContext {
  readonly executor: Executor;
  /** Members' scoped MCP connections, which toolkits become. */
  readonly connections: McpConnectionStore;
  readonly store: ImportStore;
  /** The product database, on the connection the executor writes with. */
  readonly sql: SqlClient.SqlClient;
  readonly source: V1Source;
  readonly snapshot: V1Snapshot;
  readonly target: { readonly id: OrganizationId; readonly slug: string };
  /** The v2 owner, who creates the organization's apps and shared accounts. */
  readonly owner: string;
  /** Each imported member's v2 user, by WorkOS user id. */
  readonly users: ReadonlyMap<string, string>;
  /** What Cloud's import knows beyond v1's rows (`cloudProduct`). */
  readonly product: V1ImportProduct;
}

/** The v1 rows an item reads are org rows or one member's own (`subject`). */
type Owned = { readonly owner: "org" | "user"; readonly subject: string };

/**
 * The v2 user an org row or a member's row acts as: the owner for the organization's, the member
 * for theirs. A row of anyone else is never read (`readSnapshot`), so it has none.
 */
export const actorOf = (context: Pick<ItemContext, "owner" | "users">, row: Owned) =>
  row.owner === "org" ? context.owner : context.users.get(row.subject);

/** Org rows, and the rows of one member when given. */
export const visibleTo = (member: string | undefined) => (row: Owned) =>
  row.owner === "org" || (member !== undefined && row.subject === member);

const imported = (v2Kind: string, v2Id: string, note?: string): MapResult => ({
  status: "imported",
  v2Kind,
  v2Id,
  ...(note === undefined ? {} : { note }),
});

/**
 * Deploy under the app's name, then a numbered one when another app in the organization has its
 * name or address (`appNames`).
 */
const deployNamed = (context: ItemContext, naming: AppNaming, files: SourceFiles) =>
  createNamed(context.product, naming, (name) =>
    scopeGeneratedPackage(files, context.target.slug, name).pipe(
      Effect.catch(() => fail("The app package could not be named.")),
      Effect.flatMap((scoped) =>
        context.executor.apps.deploy({
          owner: organizationOwner(context.target.id),
          name,
          files: scoped,
        }),
      ),
      Effect.map((result) => result.app),
    ),
  );

/**
 * Build failures name their stage and the failure in the generated source (`buildFailed`). A
 * build that ran out of memory, or whose compiler did not answer, says nothing about the source:
 * those fail the step, which retries them.
 */
const buildFailures = {
  VersionBuildFailed: (error: VersionBuildFailed) => Effect.fail(buildFailed(error)),
};

/** Why an integration whose connections' rules differ is still one app. */
export const splitKept =
  "Its connections have different v1 rules, but an earlier run imported it as one app, which keeps the strictest rule of each tool.";

/**
 * Deploy the integration's app for the organization: shared with everyone, created by the owner.
 * An earlier run's app gets a new version. An integration whose connections' rules differ is not
 * deployed (`split`): each connection becomes its own app (`importConnectionApp`), unless an
 * earlier run imported it as one app, which stays one.
 */
export const importIntegration = (
  context: ItemContext,
  integration: IntegrationRow,
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const plan = integrationPlan(context.product, integration);
    if (!plan.ok) return yield* refused(plan);
    const planned = yield* appAccounts(context, integration);
    const generated = yield* generate(context, integration, plan.value, planned);
    if (generated.split && existing === undefined) return { kind: "split" as const };
    const owner = organizationOwner(context.target.id);
    const app =
      existing === undefined
        ? yield* deployNamed(context, integrationNaming(integration), generated.files)
        : (yield* context.executor.apps.deploy({
            owner,
            app: existing,
            files: yield* scopeGeneratedPackage(
              generated.files,
              context.target.slug,
              integrationLabel(integration),
            ).pipe(Effect.catch(() => fail("The app package could not be named."))),
          })).app;
    const note = generated.split
      ? [generated.note, splitKept].filter((text) => text !== undefined).join(" ")
      : generated.note;
    return {
      kind: "one" as const,
      result: imported("app", app.id, note),
      app: app.id,
      traced: generated.traced,
      stale: generated.stale,
      dropped: generated.dropped,
    };
  }).pipe(
    Effect.catchTags({
      ...buildFailures,
      AppNotFound: () => fail("Its imported app was removed."),
    }),
    sharedAppCreation,
    Effect.provideService(CurrentUserId, context.owner),
  );

/**
 * Deploy one connection's own app (decision 33): its integration's app as that connection alone
 * would have it, named after both. An org connection's app is shared with everyone and created by
 * the owner; a member's is theirs alone, as their connection was in v1. An earlier run's app gets a
 * new version.
 */
export const importConnectionApp = (
  context: ItemContext,
  integration: IntegrationRow,
  connection: ConnectionRow,
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const creator = actorOf(context, connection);
    if (creator === undefined) return yield* fail("Its member is not imported.");
    const created = Effect.gen(function* () {
      const plan = integrationPlan(context.product, integration);
      if (!plan.ok) return yield* refused(plan);
      const own = connectionContext(context, connection);
      const planned = yield* appAccounts(own, integration);
      const generated = yield* generate(own, integration, plan.value, planned);
      const naming = connectionAppNaming(context.snapshot, integration, connection);
      const name = connectionAppName(context.snapshot, integration, connection);
      const app =
        existing === undefined
          ? yield* deployNamed(context, naming, generated.files)
          : (yield* context.executor.apps.deploy({
              owner: organizationOwner(context.target.id),
              app: existing,
              files: yield* scopeGeneratedPackage(generated.files, context.target.slug, name).pipe(
                Effect.catch(() => fail("The app package could not be named.")),
              ),
            })).app;
      return {
        result: imported("app", app.id, generated.note),
        app: app.id,
        // The name it has: a retry's when an earlier app took the first (`appNames`).
        name: app.name,
        traced: generated.traced,
        stale: generated.stale,
        dropped: generated.dropped,
        rules: generated.rules,
      };
    }).pipe(
      Effect.catchTags({
        ...buildFailures,
        AppNotFound: () => fail("Its imported app was removed."),
      }),
    );
    return yield* (connection.owner === "org" ? sharedAppCreation(created) : created).pipe(
      Effect.provideService(CurrentUserId, creator),
    );
  });

/** The map key of a fixed account: its integration's, or its connection's own app's. */
const fixedKey = (integration: IntegrationRow, connection: ConnectionRow | undefined) =>
  connection === undefined ? integration.row_id : `${integration.row_id}:${connection.row_id}`;

/**
 * Save the account that holds the integration's fixed credentials, from v1's configuration, and
 * link it to the app's `fixed` requirement for everyone (decision 22), when the app declares one.
 * It is the organization's, created by the owner. Its map row keeps it for a retry, while the app's
 * provider for it is unchanged; linking again changes nothing. With a `connection`, the app is that
 * connection's own (decision 33), which holds its own fixed account.
 */
export const importFixedAccount = (
  context: ItemContext,
  integration: IntegrationRow,
  app: AppId,
  connection?: ConnectionRow,
) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    const deployed = yield* context.executor.apps.get({ owner, app });
    const requirement = deployed.requirements.accounts[fixedRequirement];
    if (requirement === undefined) return undefined;
    const scoped = connection === undefined ? context : connectionContext(context, connection);
    const fixed = yield* fixedAccount(yield* appAccounts(scoped, integration));
    const hash = yield* sourceHash({ provider: requirement.provider, fields: fixed.names });
    const key = fixedKey(integration, connection);
    const existing = yield* context.store.find("fixed_credentials", key);
    const record = (result: MapResult) =>
      context.store.record({
        organization: context.snapshot.tenant,
        kind: "fixed_credentials",
        id: key,
        result,
        hash,
      });
    const label =
      connection === undefined
        ? integrationLabel(integration)
        : connectionAppName(context.snapshot, integration, connection);
    const account =
      existing?.status === "imported" && existing.v2_id !== null && existing.source_hash === hash
        ? AccountId.make(existing.v2_id)
        : yield* context.executor[StorageHost].transaction(
            Effect.gen(function* () {
              const added = yield* context.executor.managedAccounts
                .add({
                  owner,
                  provider: requirement.provider,
                  method: fixedRequirement,
                  label: `${label} fixed credentials`,
                  fields: fixed.values,
                })
                .pipe(accountDestination({ kind: "shared" }));
              yield* record(imported("account", added.id));
              return added.id;
            }),
          );
    yield* linkAppAccount(context.executor, context.sql, {
      app,
      requirement: fixedRequirement,
      account,
      linkedBy: context.owner,
    });
    return account;
  }).pipe(
    Effect.catchTag("AppNotFound", () => fail("Its imported app was removed.")),
    Effect.provideService(CurrentUserId, context.owner),
  );

/**
 * Generate and compile the integration's app as an import would, and read the requirements it
 * declares, writing nothing: no app, version or source is saved, and the build is neither kept
 * nor cached (`apps.build`). The dry run's check that every app builds. `split` says the import
 * makes an app per connection instead, which the dry run checks with a `connection` each.
 */
export const checkIntegration = (
  context: Pick<ItemContext, "executor" | "snapshot" | "source" | "product"> & {
    /** Names the build in its errors; nothing is saved under it. */
    readonly owner: OwnerId;
    /** The slug the organization would get, which scopes the app's package name. */
    readonly slug: string;
  },
  integration: IntegrationRow,
  connection?: ConnectionRow,
) =>
  Effect.gen(function* () {
    const plan = integrationPlan(context.product, integration);
    if (!plan.ok) return yield* refused(plan);
    const scoped = connection === undefined ? context : connectionContext(context, connection);
    const planned = yield* appAccounts(scoped, integration);
    const generated = yield* generate(scoped, integration, plan.value, planned);
    const name =
      connection === undefined
        ? integrationLabel(integration)
        : connectionAppName(context.snapshot, integration, connection);
    const built = yield* context.executor.apps.build({
      owner: context.owner,
      name,
      files: yield* scopeGeneratedPackage(generated.files, context.slug, name).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
      ),
    });
    return {
      name,
      note: generated.note,
      traced: generated.traced,
      stale: generated.stale,
      dropped: generated.dropped,
      health: generated.health,
      split: generated.split,
      rules: generated.rules,
      accounts: built.requirements.accounts,
    };
  }).pipe(Effect.catchTags(buildFailures));

/**
 * Check the account `importFixedAccount` would save for the app, against the requirements its
 * build declares, and save nothing.
 */
export const checkFixedAccount = (
  context: Pick<ItemContext, "executor" | "snapshot" | "source" | "product">,
  integration: IntegrationRow,
  accounts: AppAccountRequirements,
  connection?: ConnectionRow,
) =>
  Effect.gen(function* () {
    const requirement = accounts[fixedRequirement];
    if (requirement === undefined) return;
    const scoped = connection === undefined ? context : connectionContext(context, connection);
    yield* context.executor[OAuthGrantImport].checkAccountFields({
      provider: requirement.provider,
      definition: requirement.definition,
      method: fixedRequirement,
      fields: (yield* fixedAccount(yield* appAccounts(scoped, integration))).values,
    });
  });

/**
 * Save the connection's account: an org connection's is shared with everyone and created by the
 * owner, a member's is their own. The map row commits with it.
 */
export const importAccount = (
  context: ItemContext,
  plan: ConnectionPlan,
  app: Pick<DeployedApp, "id" | "requirements">,
  record: (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const actor = actorOf(context, plan.row);
    if (actor === undefined) return yield* fail("Its member is not imported.");
    return yield* saveAccount(context, plan, app, record, actor, scope).pipe(
      Effect.provideService(CurrentUserId, actor),
    );
  });

const saveAccount = (
  context: ItemContext,
  plan: ConnectionPlan,
  app: Pick<DeployedApp, "id" | "requirements">,
  record: (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
  actor: string,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const creation =
      plan.row.owner === "org"
        ? accountDestination({ kind: "shared" })
        : personalAccountCreation(actor);
    const write = yield* accountWrite({
      context,
      plan,
      accounts: app.requirements.accounts,
      owner: organizationOwner(context.target.id),
      secret: (itemId) => readSecret(context, plan.row, itemId),
      scope,
    });
    if (write.kind === "fields")
      return yield* context.executor[StorageHost].transaction(
        Effect.gen(function* () {
          const account = yield* context.executor.managedAccounts.add(write.input).pipe(creation);
          yield* record(imported("account", account.id));
          return account.id;
        }),
      );
    const account = yield* context.executor[OAuthGrantImport]
      .importOAuthGrant(write.input)
      .pipe(creation, grantRefusals(context.product, write));
    // Discovery ran outside a transaction; the account is recorded as soon as it exists.
    yield* record(imported("account", account.id));
    return account.id;
  });

/**
 * The account of a connection an earlier run imported, given v1's tokens as they are now. An
 * organization copied before it moved ran in both products, and both renewed the connection's
 * grant; a service that rotates refresh tokens keeps only the last renewal's. Once the
 * organization moves, v1 no longer renews, so its tokens are final, and the account takes them
 * when its own grant needs reconnecting or v1 renewed after it did (`refreshImportedGrant`). A
 * connection without an authorization-code grant, or whose tokens v1's Vault no longer holds, is
 * left as it is.
 */
export const refreshCopiedGrant = (context: ItemContext, row: ConnectionRow, account: AccountId) =>
  Effect.gen(function* () {
    const plan = connectionPlan(context.product, context.snapshot, row);
    if (!plan.ok) return "kept" as const;
    const tokens = yield* copiedGrantTokens(context, plan.value);
    if (tokens === undefined) return "kept" as const;
    return yield* context.executor[OAuthGrantImport].refreshImportedGrant(account, tokens);
  }).pipe(Effect.catchTag("ItemFailed", () => Effect.succeed("kept" as const)));

/**
 * Keep the account of a connection an earlier run imported fitting its app once the app is
 * generated again. The app declares one provider for every sign-in method its connections use, so
 * a connection v1 gained or lost since, or a new name, makes it another provider, which the saved
 * account does not fit. The account moves to it, under the method its connection signs in with
 * now, when that method is the one it was saved for (`moveImportedAccount`); otherwise it is left
 * as it is. Returns whether it moved.
 */
export const followAppProvider = (
  context: ItemContext,
  row: ConnectionRow,
  accounts: AppAccountRequirements,
  account: AccountId,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const requirement = accounts[accountRequirement(context.product, row)];
    const plan = connectionPlan(context.product, context.snapshot, row);
    if (requirement === undefined || !plan.ok) return false;
    const { method } = yield* accountMethod(context, plan.value, scope);
    if (method === undefined) return false;
    return yield* context.executor[OAuthGrantImport].moveImportedAccount({
      account,
      provider: requirement.provider,
      method,
    });
  }).pipe(Effect.catchTag("ItemFailed", () => Effect.succeed(false)));

/**
 * How an earlier run imported an integration: as one app, or as an app per connection (decision
 * 32), by the connection's row id. An integration imported as one app stays one, and one imported
 * per connection stays so, on every later run.
 */
export const importedApps = (
  store: Pick<ImportStore, "find">,
  snapshot: Pick<V1Snapshot, "connections">,
  integration: Pick<IntegrationRow, "row_id" | "slug">,
) =>
  Effect.gen(function* () {
    const found = yield* store.find("integration", integration.row_id);
    if (found?.status === "imported" && found.v2_id !== null)
      return { kind: "one", app: AppId.make(found.v2_id) } as const;
    const apps = new Map<string, AppId>();
    for (const connection of snapshot.connections) {
      if (connection.integration !== integration.slug) continue;
      const own = yield* store.find("connection_app", connection.row_id);
      if (own?.status === "imported" && own.v2_id !== null)
        apps.set(connection.row_id, AppId.make(own.v2_id));
    }
    return apps.size > 0 ? ({ kind: "split", apps } as const) : undefined;
  });

/**
 * The app an earlier run imported a connection's tools into: its own app, or its integration's
 * one app, with which (`scope`), or none.
 */
export const connectionAppOf = (
  store: Pick<ImportStore, "find">,
  snapshot: Pick<V1Snapshot, "connections" | "integrations">,
  row: ConnectionRow,
) =>
  Effect.gen(function* () {
    const integration = snapshot.integrations.find(
      (candidate) => candidate.slug === row.integration,
    );
    if (integration === undefined) return undefined;
    const found = yield* importedApps(store, snapshot, integration);
    const app = found?.kind === "one" ? found.app : found?.apps.get(row.row_id);
    if (found === undefined || app === undefined) return undefined;
    const scope: AppScope = found.kind === "one" ? "integration" : "own";
    return { app, scope, integration };
  });

/** The app an earlier run imported the connection's tools into, unless its users removed it. */
const importedAppOf = (context: ItemContext, row: ConnectionRow) =>
  Effect.gen(function* () {
    const found = yield* connectionAppOf(context.store, context.snapshot, row);
    if (found === undefined) return undefined;
    const app = yield* context.executor.apps
      .get({ owner: organizationOwner(context.target.id), app: found.app })
      .pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(undefined)));
    return app === undefined ? undefined : { app, scope: found.scope };
  });

/**
 * Bring the account of a connection an earlier run imported up to date with v1 and its app: it
 * takes v1's final tokens if they are newer (`refreshCopiedGrant`), and follows its app's provider
 * (`followAppProvider`).
 */
export const updateCopiedAccount = (context: ItemContext, row: ConnectionRow, account: AccountId) =>
  Effect.gen(function* () {
    const tokens = yield* refreshCopiedGrant(context, row, account);
    const found = yield* importedAppOf(context, row);
    const followed =
      found !== undefined &&
      (yield* followAppProvider(
        context,
        row,
        found.app.requirements.accounts,
        account,
        found.scope,
      ));
    return { tokens, followed };
  });

/**
 * Check the connection's account as `importAccount` would save it, against the requirements its
 * app's build declares, and save nothing: the dry run's check that every account moves. Its
 * refusals are the import's, with the same reasons. `secret` reads what the import would read
 * from v1's Vault, such as the values the dry run has already read.
 */
export const checkAccount = (
  context: Pick<ItemContext, "executor" | "source" | "product"> & {
    readonly snapshot: ConnectionSnapshot;
    /** Names the check in its errors; nothing is saved under it. */
    readonly owner: OwnerId;
  },
  plan: ConnectionPlan,
  accounts: AppAccountRequirements,
  secret: SecretReader<V1ImportUnavailable | V1ImportUnreadable>,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const write = yield* accountWrite({
      context,
      plan,
      accounts,
      owner: context.owner,
      secret,
      scope,
    });
    const host = context.executor[OAuthGrantImport];
    if (write.kind === "fields")
      return yield* host.checkAccountFields({
        provider: write.input.provider,
        definition: write.requirement.definition,
        method: write.input.method,
        fields: write.input.fields,
      });
    return yield* host
      .checkOAuthGrant({ ...write.input, definition: write.requirement.definition })
      .pipe(grantRefusals(context.product, write));
  });

/**
 * Link the connection's account to its app as linking it in v2 does: an org connection's to the
 * app's `workspace` requirement for everyone, by the owner; a member's to its `service`
 * requirement for them (decision 9). Both take many accounts, so every imported connection of an
 * integration stays usable. Linking again changes nothing, so a retried item does not duplicate it.
 */
export const linkConnectionAccount = (
  context: ItemContext,
  row: Pick<ConnectionRow, "owner" | "subject">,
  app: Pick<DeployedApp, "id">,
  account: AccountId,
) =>
  Effect.gen(function* () {
    if (row.owner === "org")
      return yield* linkAppAccount(context.executor, context.sql, {
        app: app.id,
        requirement: accountRequirement(context.product, row),
        account,
        linkedBy: context.owner,
      });
    const member = actorOf(context, row);
    if (member === undefined) return yield* fail("Its member is not imported.");
    return yield* linkUserAccount(context.executor, context.sql, {
      app: app.id,
      requirement: accountRequirement(context.product, row),
      account,
      subject: member,
    });
  });

// ---------------------------------------------------------------------------------------------
// Toolkits.

type RunTarget = ConnectionApp["runsAs"][number];

/** How an earlier item request imported an integration: one app, or an app per connection. */
export type ImportedIntegration =
  | { readonly kind: "one"; readonly id: string }
  | { readonly kind: "split" };

/**
 * What an earlier item request imported: an integration's app, or for an integration imported as
 * an app per connection (decision 33) each connection's own app, and a connection's account and
 * the target its tools run as (its linked account, or the app itself for a public app).
 */
export interface ImportedLookup {
  readonly app: (
    integration: IntegrationRow,
  ) => Effect.Effect<ImportedIntegration | undefined, V1ImportUnavailable>;
  readonly connectionApp: (
    connection: ConnectionRow,
  ) => Effect.Effect<string | undefined, V1ImportUnavailable>;
  readonly connection: (
    connection: ConnectionRow,
  ) => Effect.Effect<
    { readonly target: RunTarget; readonly account: string | null } | undefined,
    V1ImportUnavailable
  >;
}

/**
 * What a connection's tools run as once its account is linked (see `linkConnectionAccount`): an org
 * connection's account is an app link, which a call reaches through the app itself, since a grant
 * names only the caller's own accounts; a member's is their own account.
 */
export const connectionTarget = (
  row: Pick<ConnectionRow, "owner">,
  account: AccountId,
): RunTarget => (row.owner === "org" ? { kind: "app" } : { kind: "account", id: account });

/**
 * The import map's view of earlier item requests. A connection is done once its `profile` row is:
 * the row keeps the kind it had when imports made a profile per connection, so imports started
 * then still read. Its `v2_kind` is `app` for a public app's connection, whose tools run as the
 * app; otherwise the connection's account, recorded in its `connection` row, is linked to the app
 * and its tools run as `connectionTarget` says. Its `v2_id` is the linked account, or, in a row
 * from before profiles were removed, the profile, which the item's result replaces with that
 * account.
 */
export const mapLookup = (
  store: ImportStore,
  snapshot: Pick<V1Snapshot, "connections">,
): ImportedLookup => ({
  app: (integration) =>
    importedApps(store, snapshot, integration).pipe(
      Effect.map((found): ImportedIntegration | undefined =>
        found === undefined
          ? undefined
          : found.kind === "one"
            ? { kind: "one", id: found.app }
            : { kind: "split" },
      ),
    ),
  connectionApp: (connection) =>
    store
      .find("connection_app", connection.row_id)
      .pipe(
        Effect.map((found) =>
          found?.status === "imported" && found.v2_id !== null ? found.v2_id : undefined,
        ),
      ),
  connection: (connection) =>
    Effect.gen(function* () {
      const linked = yield* store.find("profile", connection.row_id);
      if (linked?.status !== "imported" || linked.v2_id === null) return undefined;
      if (linked.v2_kind === "app") return { target: { kind: "app" } as const, account: null };
      const account = yield* store.find("connection", connection.row_id);
      if (account?.status !== "imported" || account.v2_id === null) return undefined;
      return {
        target: connectionTarget(connection, AccountId.make(account.v2_id)),
        account: account.v2_id,
      };
    }),
});

const sameTarget = (a: RunTarget, b: RunTarget) =>
  a.kind === "app" ? b.kind === "app" : b.kind === "account" && a.id === b.id;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** `read` once per key; a failed read is not kept, so a later call reads again. */
const readOnce = <R, A, E>(key: (row: R) => string, read: (row: R) => Effect.Effect<A, E>) => {
  const known = new Map<string, { readonly value: A }>();
  return (row: R): Effect.Effect<A, E> => {
    const found = known.get(key(row));
    return found !== undefined
      ? Effect.succeed(found.value)
      : read(row).pipe(Effect.tap((value) => Effect.sync(() => known.set(key(row), { value }))));
  };
};

/** An integration a toolkit reaches, as its app was imported, with every member's tools. */
interface ReachedIntegration {
  readonly imported: ImportedIntegration;
  readonly all: readonly ToolRow[];
  readonly aliases: Readonly<Record<string, string>>;
  /**
   * The names the app a tool runs in leaves out: the integration's one app's, or, for an app per
   * connection, the tool's connection's own app's. None for a tool without its connection there.
   */
  readonly omitted: (connection: ConnectionRow | undefined) => ReadonlySet<string> | undefined;
}

/**
 * What every member's copy of a step's toolkits is planned from, read and decided once for the
 * step: each integration's imported app, tools and the names its app leaves out, each
 * connection's own app and what it runs as, and what each toolkit does with each tool. None of it
 * depends on the member, and a toolkit's copies write none of what `lookup` reads, so every copy
 * reads the same.
 */
export const toolkitPlanning = (
  context: { readonly snapshot: V1Snapshot; readonly source: Pick<V1Source, "tools"> },
  lookup: ImportedLookup,
) => {
  const { snapshot, source } = context;
  // The first of v1's connections at each address, as a tool names its connection.
  const addresses = new Map<string, ConnectionRow>();
  const address = (integration: string, owner: string, subject: string, name: string) =>
    JSON.stringify([integration, owner, subject, name]);
  for (const connection of snapshot.connections) {
    const key = address(
      connection.integration,
      connection.owner,
      connection.subject,
      connection.name,
    );
    if (!addresses.has(key)) addresses.set(key, connection);
  }
  const integration = readOnce(
    (row: IntegrationRow) => row.row_id,
    (row) =>
      Effect.gen(function* () {
        const imported = yield* lookup.app(row);
        if (imported === undefined) return undefined;
        // Approvals are the app's, for every member, so they read every member's tools.
        const all = yield* source.tools(snapshot.tenant, snapshot.subjects, row.slug);
        const aliases = row.plugin_id === "mcp" ? mcpNaming(all).aliases : {};
        const omittedOf = (tools: readonly ToolRow[]) =>
          new Set(approvalRules(toolActions(snapshot, row, tools, aliases)).omitted);
        const integrationOmitted = imported.kind === "one" ? omittedOf(all) : undefined;
        // A connection's own app leaves out what v1's rules blocked for it alone.
        const ownOmitted = new Map<string, ReadonlySet<string>>();
        const omitted = (connection: ConnectionRow | undefined) => {
          if (integrationOmitted !== undefined || connection === undefined)
            return integrationOmitted;
          const own = ownOmitted.get(connection.row_id) ?? omittedOf(listedAs(connection, all));
          ownOmitted.set(connection.row_id, own);
          return own;
        };
        return { imported, all, aliases, omitted } satisfies ReachedIntegration;
      }),
  );
  // What each toolkit does with each tool, which is the same for every member's copy.
  const actions = new Map<V1Toolkit, Map<string, ReturnType<typeof toolkitAction>>>();
  return {
    snapshot,
    integration,
    action: (toolkit: V1Toolkit, toolId: string) => {
      const known = actions.get(toolkit) ?? new Map<string, ReturnType<typeof toolkitAction>>();
      actions.set(toolkit, known);
      if (known.has(toolId)) return known.get(toolId);
      const action = toolkitAction(toolkit, toolId);
      known.set(toolId, action);
      return action;
    },
    /** The connection v1 listed a tool of the integration through. */
    connectionOf: (row: Pick<IntegrationRow, "slug">, tool: ToolRow) =>
      addresses.get(address(row.slug, tool.owner, tool.subject, tool.connection)),
    connectionApp: readOnce((row: ConnectionRow) => row.row_id, lookup.connectionApp),
    connection: readOnce((row: ConnectionRow) => row.row_id, lookup.connection),
  };
};
export type ToolkitPlanning = ReturnType<typeof toolkitPlanning>;

/**
 * A toolkit's scoped MCP connection: for each imported app whose tools it granted, the tools v1
 * served through it (`selected`, by the app's names) and what the connections it granted run as:
 * the app itself for an org connection or a public app's, and a member's own account for theirs. v2 selects an app's tools and accounts
 * separately, so a tool v1 granted for only some of those connections becomes available through
 * all of them; the note says so. An integration imported as an app per connection (decision 33)
 * gives each connection's app the tools granted through that connection, under its own rules.
 *
 * Each member gets their own copy (decision 11), which reaches org connections and, for the
 * member's own toolkit, their own connections; never another member's.
 */
export const toolkitPolicy = (planning: ToolkitPlanning, toolkit: V1Toolkit, member: string) =>
  Effect.gen(function* () {
    const { snapshot } = planning;
    const apps: ConnectionApp[] = [];
    const notes: string[] = [];
    const missingApps = new Set<string>();
    const missingConnections = new Set<string>();
    const blockedElsewhere = new Set<string>();
    const widened = new Set<string>();
    const visible = visibleTo(member);
    const reached = toolkitConnections(snapshot, toolkit).filter(visible);
    for (const integration of snapshot.integrations) {
      if (!reached.some((connection) => connection.integration === integration.slug)) continue;
      const found = yield* planning.integration(integration);
      const label = integrationLabel(integration);
      if (found === undefined) {
        missingApps.add(label);
        continue;
      }
      const { imported, all, aliases } = found;
      const tools = all.filter(visible);
      // The tools granted through each app, the connections granted, and which tool through which.
      const byApp = new Map<
        string,
        { names: Set<string>; granted: Map<string, ConnectionRow>; pairs: Set<string> }
      >();
      for (const tool of tools) {
        const action = planning.action(
          toolkit,
          `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`,
        );
        if (action === undefined || action === "block") continue;
        const name = Object.hasOwn(aliases, tool.name)
          ? (aliases[tool.name] ?? tool.name)
          : tool.name;
        const connection = planning.connectionOf(integration, tool);
        if (found.omitted(connection)?.has(name) === true) {
          blockedElsewhere.add(`${label} ${name}`);
          continue;
        }
        if (connection === undefined) continue;
        const appId =
          imported.kind === "one" ? imported.id : yield* planning.connectionApp(connection);
        if (appId === undefined) {
          missingApps.add(connectionAppName(snapshot, integration, connection));
          continue;
        }
        const entry = byApp.get(appId) ?? {
          names: new Set<string>(),
          granted: new Map<string, ConnectionRow>(),
          pairs: new Set<string>(),
        };
        byApp.set(appId, entry);
        entry.names.add(name);
        entry.granted.set(connection.row_id, connection);
        entry.pairs.add(`${connection.row_id} ${name}`);
      }
      for (const [appId, { names, granted, pairs }] of byApp) {
        const targets: RunTarget[] = [];
        for (const connection of granted.values()) {
          const target = (yield* planning.connection(connection))?.target;
          if (target === undefined) missingConnections.add(`${label} ${connection.name}`);
          else if (!targets.some((other) => sameTarget(other, target))) targets.push(target);
        }
        const [first, ...rest] = targets;
        if (first === undefined) continue;
        if (names.size * granted.size > pairs.size) widened.add(label);
        apps.push({
          app: AppId.make(appId),
          runsAs: [first, ...rest],
          tools: { kind: "selected", names: [...names].sort().map((name) => ToolName.make(name)) },
        });
      }
    }
    if (reached.length === 0) notes.push(grantsNoConnection);
    if (missingApps.size > 0)
      notes.push(`Not imported, so left out: ${[...missingApps].join(", ")}.`);
    if (missingConnections.size > 0)
      notes.push(
        `${plural(missingConnections.size, "connection was", "connections were")} not imported and ${missingConnections.size === 1 ? "is" : "are"} left out: ${[...missingConnections].join(", ")}.`,
      );
    if (blockedElsewhere.size > 0)
      notes.push(
        `${plural(blockedElsewhere.size, "tool", "tools")} v1 allowed only through this toolkit ${blockedElsewhere.size === 1 ? "is" : "are"} blocked in the workspace, so ${blockedElsewhere.size === 1 ? "it is" : "they are"} left out: ${[...blockedElsewhere].sort().join(", ")}.`,
      );
    if (widened.size > 0)
      notes.push(
        `v2 grants an app's selected tools through every selected account, so some tools are now available through more accounts of ${[...widened].join(", ")} than in v1.`,
      );
    if (toolkit.access.some((pattern) => pattern.split(".")[0] === "executor"))
      notes.push("It granted v1's built-in tools, which v2 does not have.");
    return { policy: { apps } satisfies ConnectionPolicy, notes };
  });

/**
 * The connection's id: stable for the toolkit, the member's copy, the organization and the
 * generation, so a retry updates it.
 */
export const toolkitConnectionId = (
  organization: string,
  toolkit: V1Toolkit,
  member: string,
  generation: number,
) =>
  toolkitCopyConnectionId(organization, toolkit.row.row_id, member, generation).pipe(
    Effect.map((id) => ConnectionId.make(id)),
  );

/**
 * What the import map holds for one member's copy of a toolkit: the connection an earlier run saved
 * it as, a row for an attempt that saved none, or no row at all. Only a rollback deletes map rows,
 * so a connection that already holds an unmapped copy's id was made by an import that was rolled
 * back.
 */
export type ToolkitCopyRecord =
  | { readonly kind: "saved"; readonly connection: string }
  | { readonly kind: "unsaved" }
  | { readonly kind: "unmapped" };

/** The members who get a copy of a toolkit: everyone for an org toolkit, else its owner. */
export const toolkitMembers = (toolkit: V1Toolkit, members: readonly string[]) =>
  toolkit.row.owner === "org"
    ? members
    : members.filter((member) => member === toolkit.row.subject);

/** The map key of one member's copy of a toolkit. */
export const toolkitCopyKey = (toolkit: Pick<V1Toolkit, "row">, member: string) =>
  toolkitCopyId(toolkit.row.row_id, member);

/**
 * Create or update a member's copy of the toolkit: a scoped MCP connection they own. A copy the
 * import map records keeps its connection, which for a copy the opt-in import made is not the id an
 * import gives a copy now. Any other copy takes generation 0's id. When another connection holds
 * an unmapped copy's id, one a rolled-back import made, the copy takes the next generation's: that
 * connection stays revoked under its id, so its grants and tokens never come back. Otherwise a
 * taken id means its users removed the copy. `planning` is the step's, shared by every copy it
 * saves.
 */
export const importToolkit = (
  context: ItemContext,
  planning: ToolkitPlanning,
  toolkit: V1Toolkit,
  member: string,
  record: ToolkitCopyRecord,
) =>
  Effect.gen(function* () {
    const user = context.users.get(member);
    if (user === undefined) return yield* fail("Its member is not imported.");
    const { policy, notes } = yield* toolkitPolicy(planning, toolkit, member);
    const owner = { userId: user, resource: context.target.id };
    const name = (toolkit.data.name.trim() === "" ? toolkit.data.slug : toolkit.data.name).slice(
      0,
      80,
    );
    const note = notes.length === 0 ? undefined : notes.join(" ");
    const live = yield* context.connections.list(owner);
    const save = (id: ConnectionId) =>
      Effect.gen(function* () {
        return live.some((connection) => connection.id === id)
          ? yield* context.connections.update(owner, { id, name, policy })
          : yield* context.connections.create(owner, { id, name, policy });
      });
    if (record.kind === "saved") {
      const saved = yield* save(ConnectionId.make(record.connection));
      return imported("mcp_connection", saved.id, note);
    }
    // Each rollback leaves at most one generation of a copy behind, so the walk ends at the first
    // generation after them. A retry finds the copy it saved there live and updates it.
    for (let generation = 0; ; generation++) {
      const id = yield* toolkitConnectionId(context.target.id, toolkit, member, generation);
      const saved = yield* save(id).pipe(
        Effect.map(Option.some),
        Effect.catchTag("ConnectionIdTaken", (taken) =>
          record.kind === "unmapped" ? Effect.succeedNone : Effect.fail(taken),
        ),
      );
      if (Option.isSome(saved)) return imported("mcp_connection", saved.value.id, note);
    }
  }).pipe(
    Effect.catchTags({
      ConnectionIdTaken: () => fail("Its MCP connection was removed in v2."),
      ConnectionNotFound: () => fail("Its MCP connection was removed in v2."),
    }),
  );

// ---------------------------------------------------------------------------------------------
// Artifacts.

/** Where one role of an artifact's code maps to in v2, or why it does not. */
export interface ArtifactRoleMapping {
  readonly role: string;
  readonly integration: string;
  readonly v1: ArtifactBinding | null;
  readonly app: { readonly id: string; readonly name: string } | null;
  readonly account: string | null;
  readonly problem: string | null;
}

/** Why a role v1 left unbound maps to no app of an integration imported per connection. */
const unboundSplit =
  "v1 bound no connection to it, and its integration became an app per connection.";

/**
 * Each role's imported app and linked account, read from the import map. A role of an integration
 * imported as an app per connection (decision 33) maps to its bound connection's own app.
 */
export const artifactMapping = (
  snapshot: Pick<V1Snapshot, "integrations" | "connections">,
  lookup: ImportedLookup,
  row: ArtifactRow,
) =>
  Effect.gen(function* () {
    const planned = artifactPlan(snapshot, row);
    const roles = yield* Effect.forEach(planned.roles, ({ use, integration, connection }) =>
      Effect.gen(function* () {
        const mapping = (
          rest: Partial<Omit<ArtifactRoleMapping, "role" | "integration" | "v1">>,
        ): ArtifactRoleMapping => ({
          role: use.role,
          integration: use.integration,
          v1: use.binding ?? null,
          app: null,
          account: null,
          problem: null,
          ...rest,
        });
        if (integration === undefined)
          return mapping({ problem: "Its integration no longer exists in v1." });
        const found = yield* lookup.app(integration);
        if (found === undefined) return mapping({ problem: "Its integration was not imported." });
        if (found.kind === "split") {
          if (use.binding === undefined) return mapping({ problem: unboundSplit });
          if (connection === undefined)
            return mapping({ problem: "Its connection no longer exists in v1." });
        }
        const appId =
          found.kind === "one"
            ? found.id
            : connection === undefined
              ? undefined
              : yield* lookup.connectionApp(connection);
        if (appId === undefined)
          return mapping({ problem: "Its connection's app was not imported." });
        const app = {
          id: appId,
          name:
            found.kind === "one" || connection === undefined
              ? integrationLabel(integration)
              : connectionAppName(snapshot, integration, connection),
        };
        if (use.binding === undefined)
          return mapping({ app, problem: "v1 bound no connection to it." });
        if (connection === undefined)
          return mapping({ app, problem: "Its connection no longer exists in v1." });
        const imported = yield* lookup.connection(connection);
        if (imported === undefined)
          return mapping({ app, problem: "Its connection was not imported." });
        return mapping({ app, account: imported.account });
      }),
    );
    return { roles, builtIn: planned.builtIn };
  });

const commentText = (text: string) => text.replace(/\*\//g, "*\\/");
const htmlText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The artifact's app package: its v1 code unchanged as the page component, the page and package
 * scaffolding, an app with no tools yet, and `v1-artifact.json` with each role's mapping.
 */
export const artifactFiles = (
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
) => {
  const title = row.title.trim() === "" ? "Artifact" : row.title;
  return [
    packageFile(title, { react: "^19.2.0", "react-dom": "^19.2.0" }),
    {
      path: "index.ts",
      content: `import { defineApp, router } from "apps";

/**
 * Imported from the Executor v1 artifact ${commentText(JSON.stringify(title))}. Its page,
 * ui/artifact.tsx, called other integrations' tools from the browser (\`tools.<integration>...\`),
 * and a v2 app's page calls only its own app's tools. Add tools here that do what the page needs,
 * then rewrite the page to call them through \`apps/client\`. v1-artifact.json lists the imported
 * app and account each \`tools.<role>\` call used.
 */
export default defineApp({}, { tools: router({}) });
`,
    },
    {
      path: "ui/index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlText(title)}</title>
    <script type="module" src="./main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
    },
    {
      path: "ui/main.tsx",
      content: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// v1 ran artifact.tsx with its globals in scope (React hooks, TanStack Query, its UI components
// and \`tools\`) and rendered its \`App\`. Import what it uses there and export \`App\`.
import { App } from "./artifact.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    },
    { path: "ui/artifact.tsx", content: row.code },
    {
      path: "v1-artifact.json",
      content: `${JSON.stringify(
        {
          title: row.title,
          description: row.description,
          builtInTools: mapping.builtIn,
          roles: Object.fromEntries(
            mapping.roles.map(({ role, ...rest }) => [role, rest] as const),
          ),
        },
        null,
        2,
      )}\n`,
    },
  ];
};

/** What the user should know: what needs repair, and where each role's calls now go. */
export const artifactNote = (mapping: {
  readonly roles: readonly ArtifactRoleMapping[];
  readonly builtIn: boolean;
}) => {
  const mapped = mapping.roles.filter((role) => role.problem === null);
  const unmapped = mapping.roles.filter((role) => role.problem !== null);
  return [
    artifactRepairNote,
    ...(mapped.length === 0
      ? []
      : [
          `Its calls map to ${mapped
            .map(
              (role) =>
                `${role.role} → ${role.app?.name ?? role.integration} (${role.v1?.connection ?? "no connection"})`,
            )
            .join(", ")}.`,
        ]),
    ...unmapped.map((role) => `${role.role}: ${role.problem}`),
    ...(mapping.builtIn ? ["It also calls v1's built-in tools, which v2 does not have."] : []),
  ].join(" ");
};

/**
 * Save the artifact as a private app without a version: `apps.create` keeps its source and builds
 * nothing, so it does not run until it is repaired. An earlier import's app gets a new commit.
 */
export const importArtifact = (
  context: ItemContext,
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    // An org artifact's creator is the owner; a member's artifact stays theirs.
    const creator = actorOf(context, row);
    if (creator === undefined) return yield* fail("Its member is not imported.");
    return yield* saveArtifact(context, row, mapping, existing).pipe(
      Effect.provideService(CurrentUserId, creator),
    );
  });

const saveArtifact = (
  context: ItemContext,
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    const title = row.title.trim() === "" ? "Artifact" : row.title;
    const files = yield* Schema.decodeUnknownEffect(SourceFiles)(artifactFiles(row, mapping)).pipe(
      Effect.catch(() => fail("Its source is too large for an app.")),
    );
    const note = artifactNote(mapping);
    if (existing !== undefined) {
      const updated = yield* Effect.gen(function* () {
        const workspace = yield* context.executor.apps.workspace({ app: existing, owner });
        const scoped = yield* scopeGeneratedPackage(files, context.target.slug, title).pipe(
          Effect.catch(() => fail("The app package could not be named.")),
        );
        yield* context.executor.apps.commit({
          app: existing,
          owner,
          expected: workspace.revision.commit,
          files: scoped,
          message: "Update from the Executor v1 artifact",
        });
        return Option.some(existing);
      }).pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(Option.none<AppId>())));
      if (Option.isSome(updated)) return { ...imported("undeployed_app", updated.value, note) };
    }
    const created = yield* createNamed(context.product, artifactNaming(row), (name) =>
      scopeGeneratedPackage(files, context.target.slug, name).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
        Effect.flatMap((scoped) => context.executor.apps.create({ owner, name, files: scoped })),
      ),
    );
    return imported("undeployed_app", created.id, note);
  });
