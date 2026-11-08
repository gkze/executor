/**
 * Read a local Executor 1 data directory and decide what each item becomes in this Executor
 * (`executor import-v1`), with the shared v1 decisions Cloud's import also makes. It reads
 * Executor 1's SQLite database and `auth.json` read-only and writes nothing; an import
 * (`v1-import-apply.ts`) writes through the background Executor.
 *
 * Local Executor 1 differed from v1 Cloud in what it read: one person (`local`), one tenant per
 * folder it ran in, credentials in `auth.json` (its `file` provider) or another provider plugin,
 * and local (stdio) MCP servers it ran itself.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { homedir } from "node:os";
import {
  ConnectionRow,
  IntegrationRow,
  OAuthClientRow,
  OpenApiOperationRow,
  PolicyRow,
  ToolkitRow,
  ToolkitRuleRow,
  ToolRow,
  appAccounts,
  connectionPlan,
  fetchSpecification,
  generate,
  integrationLabel,
  integrationPlan,
  policyPlan,
  refused,
  type ConnectionPlan,
  type Supported,
  type Unsupported,
  type V1ImportProduct,
  type V1Reader,
  type V1Rows,
} from "@executor-js/v1-import";
import { ItemFailed, SpecificationUnavailable, itemFailed } from "@executor-js/v1-import/contracts";
import type {
  AccountFieldsInvalid,
  AuthMethodInvalid,
  BuildMemoryExceeded,
  BuildUnanswered,
  CredentialsError,
  StorageError,
} from "@executor-js/sdk/core";
import type { TemplateError } from "@executor-js/app-templates";
import { Effect, FileSystem, Option, Path, Predicate, Schema, type Scope } from "effect";
import { HttpClient } from "effect/http";
import { StdioBridgeFailed } from "../contracts/stdio-mcp.ts";
import { stdioAppSource } from "./stdio-mcp.ts";
import {
  type V1ImportItem,
  type V1ImportOutcome,
  type V1ImportProblem,
  type V1ImportReport,
  V1ImportFailed,
} from "../contracts/v1-import.ts";

/** Local Executor 1's only person, who owned its `user` rows. */
const localSubject = "local";

/**
 * What a local import knows beyond Executor 1's rows. Executor 1 kept credentials it could read
 * in `auth.json` (its `file` provider) and offered none of Executor's own OAuth apps. It had one
 * person, so a workspace connection's account is that person's own, and its apps declare the
 * integration's sign-in methods even when no connection moves, for the person to connect later.
 * It ran local (stdio) MCP servers itself, which this Executor's local server runs for their apps.
 */
export const localProduct: V1ImportProduct = {
  credentialProvider: "file",
  firstParty: () => undefined,
  // Executor 1's server on its default port, where it sent sign-ins when a client recorded none.
  // Renewing a copied grant does not use it; signing in again with that client does.
  callback: "http://localhost:4788/api/oauth/callback",
  orgAccounts: "personal",
  declaredMethods: true,
  localServers: { runs: true, source: stdioAppSource },
  wording: {
    product: "this Executor",
    destination: "this Executor",
    signInMethod: "a sign-in method in this Executor",
    reconnect: "Connect it again in this Executor.",
    outage: "Run the import again to retry it.",
    namesTaken: "Every name for its app is taken. Rename one of those apps, then run it again.",
  },
};

/** What Executor 1 kept outside `auth.json`, as people know it. */
const providerName = (provider: string) =>
  provider === "onepassword" ? "1Password" : `Executor 1's ${provider} plugin`;

const failed = (problem: V1ImportProblem) => new V1ImportFailed({ problem });

/** Rows owned by the workspace or by local Executor 1's one person. */
const visible = `(owner = 'org' or (owner = 'user' and subject = '${localSubject}'))`;
/** A column of milliseconds Executor 1 stored as decimal text in a BLOB. */
const millis = (column: string) => `cast(cast(${column} as text) as real)`;

/**
 * One tenant's rows, as Cloud reads them from its Postgres (`readSnapshot`), from SQLite. JSON
 * columns are stored as BLOBs, `created_at` in seconds, and `config_revised_at` and `expires_at`
 * as milliseconds in decimal text.
 */
const tenantRows = (database: DatabaseSync, tenant: string) => {
  const all = (sql: string) => database.prepare(sql).all(tenant);
  return {
    integrations: all(`
      select row_id, slug, plugin_id, name, cast(config as text) as config,
        cast(health_check as text) as health_check,
        ${millis("config_revised_at")} as config_revised_at, created_at * 1000.0 as created_ms
      from integration where tenant = ? order by created_at, slug`),
    connections: all(`
      select row_id, owner, subject, integration, name, template, provider,
        cast(item_ids as text) as item_ids, oauth_client, oauth_client_owner, refresh_item_id,
        ${millis("expires_at")} as expires_at, oauth_scope, oauth_token_url,
        created_at * 1000.0 as created_ms
      from connection where tenant = ? and ${visible} order by created_at, row_id`),
    clients: all(`
      select row_id, owner, subject, slug, authorization_url, token_url, "grant", client_id,
        client_secret_item_id, token_endpoint_auth_method, resource, origin_kind, origin_issuer,
        origin_redirect_uri
      from oauth_client where tenant = ? and ${visible}`),
    policies: all(`
      select row_id, owner, subject, id, pattern, action, position
      from tool_policy where tenant = ? and ${visible} order by owner, position, id`),
    toolkits: all(`
      select row_id, owner, subject, key, cast(data as text) as data from plugin_storage
      where tenant = ? and plugin_id = 'toolkits' and collection = 'toolkits' and ${visible}
      order by key`),
    toolkitRules: all(`
      select owner, subject, collection, cast(data as text) as data from plugin_storage
      where tenant = ? and plugin_id = 'toolkits'
        and collection in ('toolkitConnections', 'toolkitPolicies') and ${visible}
      order by key`),
  };
};

/** Decode rows Executor 1 stored. A failure names no table, row or value. */
const decode = <S extends Schema.Top>(schema: S, rows: unknown) =>
  Schema.decodeUnknownEffect(schema)(rows).pipe(Effect.mapError(() => failed("unreadable_rows")));

const decodeRows = (rows: ReturnType<typeof tenantRows>) =>
  Effect.all({
    integrations: decode(Schema.Array(IntegrationRow), rows.integrations),
    connections: decode(Schema.Array(ConnectionRow), rows.connections),
    clients: decode(Schema.Array(OAuthClientRow), rows.clients),
    policies: decode(Schema.Array(PolicyRow), rows.policies),
    toolkits: decode(Schema.Array(ToolkitRow), rows.toolkits),
    toolkitRules: decode(Schema.Array(ToolkitRuleRow), rows.toolkitRules),
  });

/** Each tenant with integrations, connections or tool policies: one Executor 1 workspace each. */
const tenantsSql = `
  select tenant from integration union select tenant from connection
  union select tenant from tool_policy order by tenant`;

/** `auth.json`: credential item id to value. Values stay in memory and are never printed. */
const readCredentials = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(file))) return new Map<string, string>();
    const text = yield* fs.readFileString(file);
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
    )(text).pipe(Effect.mapError(() => failed("unreadable_credentials")));
    return new Map(
      Object.entries(decoded).flatMap(([id, value]) =>
        typeof value === "string" && value !== "" ? [[id, value] as const] : [],
      ),
    );
  }).pipe(Effect.catchTag("PlatformError", () => Effect.fail(failed("unreadable_credentials"))));

/** A SQLite read, failing as an unreadable database. */
const query = <A>(read: () => A) =>
  Effect.try({ try: read, catch: () => failed("unreadable_database") });

/** A BLOB or text value's bytes. */
const bytesOf = (value: unknown) =>
  value instanceof Uint8Array
    ? Option.some(value)
    : typeof value === "string"
      ? Option.some(new TextEncoder().encode(value))
      : Option.none();

/**
 * What app generation reads from Executor 1 beyond its rows: listed tools, compiled OpenAPI
 * operations and bindings, stored specifications and `auth.json`.
 */
const localReader = (
  database: DatabaseSync,
  credentials: ReadonlyMap<string, string>,
  specification: (url: string) => Effect.Effect<Uint8Array, SpecificationUnavailable>,
): V1Reader<V1ImportFailed> => {
  const all = (sql: string, ...params: SQLInputValue[]) =>
    query(() => database.prepare(sql).all(...params));
  const operation = (field: string) => `json_extract(cast(data as text), '$.${field}')`;
  return {
    tools: (tenant, _subjects, integration) =>
      all(
        `select owner, subject, connection, name,
          json_extract(cast(annotations as text), '$.mcp.toolName') as upstream,
          coalesce(json_extract(cast(annotations as text), '$.requiresApproval') = 1, 0)
            as requires_approval,
          (select ${millis("listed.tools_synced_at")} from connection listed
            where listed.tenant = tool.tenant and listed.integration = tool.integration
              and listed.owner = tool.owner and listed.subject = tool.subject
              and listed.name = tool.connection limit 1) as listed_at
        from tool where tenant = ? and integration = ? and ${visible}`,
        tenant,
        integration,
      ).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({ ...row, requires_approval: row["requires_approval"] === 1 })),
        ),
        Effect.flatMap((rows) => decode(Schema.Array(ToolRow), rows)),
      ),
    openApiOperations: (tenant, integration) =>
      all(
        `select ${operation("toolName")} as tool, ${operation("binding.method")} as method,
          ${operation("binding.pathTemplate")} as path
        from plugin_storage
        where tenant = ? and owner = 'org' and plugin_id = 'openapi' and collection = 'operation'
          and ${operation("integration")} = ?`,
        tenant,
        integration,
      ).pipe(Effect.flatMap((rows) => decode(Schema.Array(OpenApiOperationRow), rows))),
    openApiBinding: (tenant, integration, tool) =>
      all(
        `select json(${operation("binding")}) as binding from plugin_storage
        where tenant = ? and owner = 'org' and plugin_id = 'openapi' and collection = 'operation'
          and ${operation("integration")} = ? and ${operation("toolName")} = ? limit 1`,
        tenant,
        integration,
        tool,
      ).pipe(
        Effect.flatMap((rows) => {
          const binding = rows[0]?.["binding"];
          return typeof binding === "string"
            ? decode(Schema.fromJsonString(Schema.Unknown), binding)
            : Effect.succeed(undefined);
        }),
      ),
    blob: (tenant, plugin, key) =>
      all(
        `select value from blob where namespace = ? and key = ? limit 1`,
        `o:${tenant}/${plugin}`,
        key,
      ).pipe(
        Effect.map((rows) =>
          Option.flatMap(Option.fromNullishOr(rows[0]), (row) => bytesOf(row["value"])),
        ),
      ),
    blobMissing: "Executor 1's stored specification is missing.",
    specification,
    secret: ({ itemId }) => Effect.succeed(credentials.get(itemId)),
  };
};

/** One Executor 1 workspace: its rows, what generation reads beyond them, and `auth.json`'s ids. */
export interface V1Workspace {
  readonly rows: V1Rows;
  readonly reader: V1Reader<V1ImportFailed>;
  readonly stored: ReadonlySet<string>;
}

/** Executor 1's default data directory, which it used without `EXECUTOR_DATA_DIR`. */
const defaultDirectory = () =>
  Path.Path.pipe(Effect.map((path) => path.join(homedir(), ".executor")));

/** The Executor 1 data directory a command names, or Executor 1's default, as an absolute path. */
export const v1Directory = (from: Option.Option<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.resolve(
      yield* Option.match(from, { onNone: defaultDirectory, onSome: Effect.succeed }),
    );
  });

/**
 * Open an Executor 1 data directory for the scope: every workspace, or only `only`. Its database
 * stays open read-only until the scope closes; a running Executor 1 keeps writing it, and a
 * read-only reader sees its last committed state. `specification` fetches a specification
 * Executor 1 stored as its URL.
 */
export const openV1 = (
  from: string,
  only: Option.Option<string>,
  specification: (url: string) => Effect.Effect<Uint8Array, SpecificationUnavailable>,
): Effect.Effect<
  readonly V1Workspace[],
  V1ImportFailed,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(from, "data.db");
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))))
      return yield* failed("no_database");
    const database = yield* Effect.acquireRelease(
      query(() => new DatabaseSync(file, { readOnly: true })),
      (open) => Effect.sync(() => open.close()),
    );
    const tenants = (yield* query(() => database.prepare(tenantsSql).all()))
      .map((row) => String(row["tenant"]))
      .filter((tenant) => Option.match(only, { onNone: () => true, onSome: (t) => t === tenant }));
    if (Option.isSome(only) && tenants.length === 0) return yield* failed("unknown_workspace");
    const credentials = yield* readCredentials(path.join(from, "auth.json"));
    const reader = localReader(database, credentials, specification);
    const stored = new Set(credentials.keys());
    return yield* Effect.forEach(tenants, (tenant) =>
      query(() => tenantRows(database, tenant)).pipe(
        Effect.flatMap(decodeRows),
        Effect.map((decoded): V1Workspace => ({
          rows: { tenant, subjects: [localSubject], multiMember: false, ...decoded },
          reader,
          stored,
        })),
      ),
    );
  });

/** The `auth.json` items a connection's account copies: its values, client secret and token. */
const credentialItems = (plan: ConnectionPlan): readonly string[] => {
  const access = plan.access;
  switch (access.kind) {
    case "none":
      return [];
    case "secrets":
      return access.items.map(([, item]) => item);
    case "oauth":
      return [
        access.accessItem,
        ...(plan.row.refresh_item_id === null ? [] : [plan.row.refresh_item_id]),
        ...(access.client.client_secret_item_id === null
          ? []
          : [access.client.client_secret_item_id]),
      ];
    case "first_party":
      return [access.accessItem];
  }
};

/** An item's outcome and why, without its identity. */
type Decided = Pick<V1ImportItem, "outcome" | "reason" | "category">;

/**
 * A refusal decided from rows: skipped when Executor 1 could not run it either (`stale`), else
 * `refused`, the outcome the caller gives a refusal that names no category. A local (stdio)
 * server this Executor cannot run as Executor 1 did (`local_server`) cannot move: local Executor 1
 * ran it.
 */
const outcome = (plan: Supported<unknown> | Unsupported, refused: V1ImportOutcome): Decided =>
  plan.ok
    ? { outcome: "moves" }
    : plan.stale === "local_server"
      ? { outcome: "cannot_move", reason: plan.reason, category: plan.stale }
      : plan.stale !== null
        ? { outcome: "skipped", reason: plan.reason, category: plan.stale }
        : { outcome: refused, reason: plan.reason };

/** An integration's label by slug, or the slug when it no longer exists. */
const labelOf = (rows: V1Rows, slug: string) => {
  const integration = rows.integrations.find((candidate) => candidate.slug === slug);
  return integration === undefined ? slug : integrationLabel(integration);
};

/**
 * What an integration becomes, from its row alone: an app generated from it. A local (stdio) MCP
 * server's app calls the command this Executor's local server runs for it.
 */
export const planIntegration = (row: IntegrationRow): V1ImportItem => ({
  kind: "integration",
  id: row.slug,
  label: integrationLabel(row),
  integration: null,
  ...outcome(integrationPlan(localProduct, row), "cannot_move"),
});

/** A connection's item, before what it becomes. */
const connectionItem = (rows: V1Rows, row: ConnectionRow) =>
  ({
    kind: "connection",
    id: row.row_id,
    integration: labelOf(rows, row.integration),
    label: `${labelOf(rows, row.integration)} / ${row.name}`,
  }) as const;

/** What a connection becomes, from its rows and the credentials `auth.json` holds. */
export const planConnection = (workspace: V1Workspace, row: ConnectionRow): V1ImportItem => {
  const { rows } = workspace;
  const named = connectionItem(rows, row);
  const integration = rows.integrations.find((candidate) => candidate.slug === row.integration);
  const plan = connectionPlan(localProduct, rows, row);
  // A connection of an integration that does not move goes with it.
  if (integration === undefined || !integrationPlan(localProduct, integration).ok)
    return { ...named, ...outcome(plan, "cannot_move") };
  if (!plan.ok && plan.elsewhere !== undefined)
    return {
      ...named,
      outcome: "reconnect",
      reason: `Its credential is kept in ${providerName(plan.elsewhere)}, which the import does not read. ${localProduct.wording.reconnect}`,
    };
  if (!plan.ok) return { ...named, ...outcome(plan, "reconnect") };
  return credentialItems(plan.value).some((itemId) => !workspace.stored.has(itemId))
    ? {
        ...named,
        outcome: "skipped",
        reason: `auth.json no longer holds its saved credential. ${localProduct.wording.reconnect}`,
        category: "missing_credential",
      }
    : { ...named, outcome: "moves" };
};

/** A tool policy's item, before what it becomes. */
const policyItem = (rows: V1Rows, row: PolicyRow) => {
  const first = row.pattern.split(".")[0] ?? "";
  return {
    kind: "tool_policy",
    id: row.id,
    label: `${row.action} ${row.pattern}`,
    integration: first === "*" ? null : labelOf(rows, first),
  } as const;
};

/** What a tool policy becomes from its row alone: rules in the apps of the integrations it names. */
const planPolicy = (rows: V1Rows, row: PolicyRow): V1ImportItem => {
  const plan = policyPlan(rows, row);
  return {
    ...policyItem(rows, row),
    ...(plan.status === "will_import"
      ? { outcome: "moves" as const }
      : { outcome: "skipped" as const, reason: plan.reason }),
  };
};

/** One workspace's items from its rows alone, which say which items the import sends. */
const planWorkspace = (workspace: V1Workspace) => [
  ...workspace.rows.integrations.map(planIntegration),
  ...workspace.rows.connections.map((row) => planConnection(workspace, row)),
  ...workspace.rows.policies.map((row) => planPolicy(workspace.rows, row)),
];

/** The errors whose tag says what they mean for an item; see {@link failures}. */
type KnownFailure =
  | AuthMethodInvalid
  | AccountFieldsInvalid
  | BuildMemoryExceeded
  | BuildUnanswered
  | StorageError
  | CredentialsError
  | TemplateError;

/**
 * What a known failure means for its item, by tag. A refusal of the item as it is
 * (`cannot_move`) happens again on every run; anything else is `failed`, which a later run may
 * get past. Reasons are fixed text: an error's own message is never shown. A build that failed is
 * `ItemFailed` by then (`buildFailed`), whose reason keeps the build's message: it describes the
 * generated source, never a credential.
 */
const failures: { readonly [Tag in KnownFailure["_tag"]]: Decided } = {
  AuthMethodInvalid: {
    outcome: "cannot_move",
    reason: "Its sign-in method is not in its app, which keeps an earlier version.",
  },
  AccountFieldsInvalid: {
    outcome: "cannot_move",
    reason: "Its saved credential does not have the fields its app's sign-in method takes.",
  },
  BuildMemoryExceeded: { outcome: "failed", reason: "Building its app ran out of memory." },
  BuildUnanswered: { outcome: "failed", reason: "Building its app did not finish." },
  StorageError: { outcome: "failed", reason: "This Executor could not save it." },
  CredentialsError: { outcome: "failed", reason: "This Executor could not save its credential." },
  TemplateError: { outcome: "cannot_move", reason: "Its app could not be generated." },
};

const isKnownFailure = (tag: unknown): tag is KnownFailure["_tag"] =>
  typeof tag === "string" && Object.hasOwn(failures, tag);

/**
 * What a failed step means for its item; see {@link failures}. A local server's app that does not
 * take the endpoint the local server makes for it cannot run it until it does; a record the local
 * server could not read or write may be fine on a later run.
 */
const decideFailure = (error: unknown): Decided => {
  if (error instanceof ItemFailed)
    return error.outage === true || error.credential === "unavailable"
      ? { outcome: "failed", reason: error.reason }
      : error.stale !== undefined
        ? { outcome: "skipped", reason: error.reason, category: error.stale }
        : { outcome: "cannot_move", reason: error.reason };
  // The import gives a command only to a version that takes the endpoint, so what can fail here
  // is recording it.
  if (error instanceof StdioBridgeFailed)
    return { outcome: "failed", reason: "This Executor could not record its local server." };
  const tag = Predicate.hasProperty(error, "_tag") ? error._tag : undefined;
  return isKnownFailure(tag)
    ? failures[tag]
    : { outcome: "failed", reason: "It could not be imported." };
};

/**
 * A failed step's outcome for its item (`decideFailure`), keeping a failure to read Executor 1 or
 * keep the import's record, which stops the whole import.
 */
export const settle = <A, E, R>(step: Effect.Effect<A, E, R>) =>
  step.pipe(
    Effect.map((value) => ({ ok: true, value }) as const),
    Effect.catch((error) =>
      error instanceof V1ImportFailed
        ? Effect.fail(error)
        : Effect.succeed({ ok: false, decided: decideFailure(error) } as const),
    ),
  );

/**
 * The app an integration's import deploys, generated from fresh rows, writing nothing: its files,
 * what it takes, and what to tell the person. An integration whose connections' rules differ
 * would become an app per connection (decision 33), which a local import does not do yet, so it is
 * refused as it is.
 */
export const generateApp = (workspace: V1Workspace, integration: IntegrationRow) =>
  Effect.gen(function* () {
    const plan = integrationPlan(localProduct, integration);
    if (!plan.ok) return yield* refused(plan);
    const context = { product: localProduct, snapshot: workspace.rows, source: workspace.reader };
    const planned = yield* appAccounts(context, integration);
    const generated = yield* generate(context, integration, plan.value, planned);
    if (generated.split)
      return yield* itemFailed(
        "Its connections have different Executor 1 approval rules, which this Executor would split into an app per connection; the local import does not split integrations yet.",
      );
    return { decoded: plan.value, planned, generated };
  });

/** What became of an integration, which its connections and tool policies follow. */
export type IntegrationResult = Pick<V1ImportItem, "outcome"> & {
  readonly reason?: string | undefined;
};

/** A connection's item when its integration's app was not made: it goes with it. */
export const followIntegration = (
  item: V1ImportItem,
  integration: IntegrationResult,
): V1ImportItem =>
  item.outcome !== "moves" || integration.outcome === "moves"
    ? item
    : {
        ...item,
        outcome: integration.outcome === "failed" ? "failed" : "cannot_move",
        reason: "Its integration's app was not made.",
      };

/**
 * What a tool policy became, from what became of the integrations it names: rules in each of
 * their apps that was made, as the app's source holds them. Only the apps this import made or kept
 * count; `results` holds the integrations it handled.
 */
export const policyOutcome = (
  rows: V1Rows,
  row: PolicyRow,
  results: ReadonlyMap<string, IntegrationResult>,
): V1ImportItem | undefined => {
  const plan = policyPlan(rows, row);
  if (plan.status !== "will_import") return undefined;
  const targets = plan.integrations.flatMap((integration) => {
    const result = results.get(integration.slug);
    return result === undefined ? [] : [result];
  });
  if (targets.length === 0) return undefined;
  const named = policyItem(rows, row);
  if (targets.some((target) => target.outcome === "moves")) return { ...named, outcome: "moves" };
  if (targets.some((target) => target.outcome === "failed"))
    return { ...named, outcome: "failed", reason: "Its integration's app was not made." };
  return { ...named, outcome: "cannot_move", reason: "Its integration's app cannot be made." };
};

/**
 * The dry run: every item decided as an import would decide it, writing nothing. Each app is
 * generated, which fetches a specification Executor 1 stored as its URL, but not built or saved.
 */
const dryRunWorkspace = (workspace: V1Workspace) =>
  Effect.gen(function* () {
    const { rows } = workspace;
    const results = new Map<string, IntegrationResult>();
    const items: V1ImportItem[] = [];
    for (const row of rows.integrations) {
      const planned = planIntegration(row);
      const decided =
        planned.outcome !== "moves"
          ? planned
          : yield* settle(generateApp(workspace, row)).pipe(
              Effect.map((app) => (app.ok ? planned : { ...planned, ...app.decided })),
            );
      results.set(row.slug, { outcome: decided.outcome, reason: decided.reason });
      items.push(decided);
    }
    for (const row of rows.connections) {
      const item = planConnection(workspace, row);
      const integration = results.get(row.integration);
      items.push(integration === undefined ? item : followIntegration(item, integration));
    }
    for (const row of rows.policies)
      items.push(policyOutcome(rows, row, results) ?? planPolicy(rows, row));
    return items;
  });

/** A specification an import fetches is not fetched to plan from rows. */
const unfetched = () =>
  Effect.fail(new SpecificationUnavailable({ reason: "A plan from rows fetches nothing." }));

/**
 * An Executor 1 data directory's items, per workspace: from rows alone (`rows`), which say what an
 * import sends, or as a dry run decides them (`dry_run`), which generates each app as the import
 * would and fetches a specification Executor 1 stored as its URL.
 */
export const planV1Import = (
  from: string,
  workspace: Option.Option<string>,
  mode: "rows" | "dry_run",
) =>
  Effect.gen(function* () {
    const http = mode === "dry_run" ? yield* HttpClient.HttpClient : undefined;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const workspaces = yield* openV1(from, workspace, (url) =>
          http === undefined ? unfetched() : fetchSpecification(http, url),
        );
        return yield* Effect.forEach(workspaces, (open) =>
          (mode === "dry_run" ? dryRunWorkspace(open) : Effect.succeed(planWorkspace(open))).pipe(
            Effect.map((items) => ({ tenant: open.rows.tenant, items })),
          ),
        );
      }),
    );
  });

const outcomes = ["moves", "reconnect", "cannot_move", "skipped", "failed"] as const;
const outcomeWords = (dryRun: boolean): Record<V1ImportOutcome, string> => ({
  moves: dryRun ? "move" : "moved",
  reconnect: dryRun ? "move without their credential" : "moved without their credential",
  cannot_move: "cannot move",
  skipped: "skipped",
  failed: "failed",
});
const kindWords: Record<V1ImportItem["kind"], string> = {
  integration: "Integrations",
  connection: "Connections",
  tool_policy: "Tool policies",
};
const sections = (dryRun: boolean): ReadonlyArray<readonly [V1ImportOutcome, string]> => [
  ["failed", "Failed; run the import again to retry them:"],
  [
    "reconnect",
    dryRun
      ? "Move without their credential; connect them again afterwards:"
      : "Moved without their credential; connect them again:",
  ],
  ["cannot_move", "Cannot move:"],
  ["skipped", "Skipped, because Executor 1 could not run them either:"],
];

/** The report for a person: counts per workspace, then every item that does not simply move. */
export const renderReport = (report: V1ImportReport) => {
  const lines: string[] = [`Executor 1 data in ${report.from}`];
  if (report.workspaces.length === 0)
    lines.push("", "It has no integrations, connections or tool policies.");
  for (const workspace of report.workspaces) {
    lines.push("", `Workspace ${workspace.tenant}`);
    for (const kind of ["integration", "connection", "tool_policy"] as const) {
      const items = workspace.items.filter((item) => item.kind === kind);
      if (items.length === 0) continue;
      const counts = outcomes
        .map((result) => [result, items.filter((item) => item.outcome === result).length] as const)
        .filter(([, count]) => count > 0)
        .map(([result, count]) => `${count} ${outcomeWords(report.dryRun)[result]}`);
      lines.push(`  ${kindWords[kind]}: ${counts.join(", ")}`);
    }
    for (const [result, heading] of sections(report.dryRun)) {
      const items = workspace.items.filter((item) => item.outcome === result);
      if (items.length === 0) continue;
      lines.push("", `  ${heading}`);
      for (const item of items) lines.push(`    ${item.label}: ${item.reason ?? ""}`);
    }
  }
  lines.push(
    "",
    report.dryRun
      ? "Nothing was written. Run without --dry-run to import."
      : "Running the import again moves only what has not moved.",
  );
  return lines.join("\n");
};
