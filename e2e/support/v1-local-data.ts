/**
 * A local Executor 1 data directory for `executor import-v1` to read: its SQLite `data.db` and its
 * `auth.json` credential file. Columns hold values as Executor 1 stored them: JSON as BLOBs,
 * `created_at` in seconds and `config_revised_at`/`expires_at` as milliseconds in decimal text.
 * A connection's OAuth sign-in names a workspace client by slug, with its token items in
 * `auth.json` as Executor 1's `file` provider kept them.
 * Only the tables and columns the import reads exist.
 */
import { DatabaseSync } from "node:sqlite";
import { Effect, FileSystem, Path } from "effect";

export interface V1Integration {
  readonly tenant: string;
  readonly slug: string;
  readonly plugin: "mcp" | "openapi" | "graphql";
  readonly name: string;
  readonly config: unknown;
}

export interface V1Connection {
  readonly tenant: string;
  readonly rowId: string;
  readonly integration: string;
  readonly name: string;
  readonly template: string;
  /** Where Executor 1 kept the credential: `file` is `auth.json`. */
  readonly provider: string;
  /** Variable to credential item id. */
  readonly items: Readonly<Record<string, string>>;
  readonly owner?: "org" | "user";
  /** A sign-in through an OAuth client: its slug, refresh token item, expiry and granted scope. */
  readonly oauth?: {
    readonly client: string;
    readonly refreshItem: string;
    readonly expiresAt: number;
    readonly scope: string;
  };
}

/** A workspace OAuth client, as Executor 1 registered it. */
export interface V1OAuthClient {
  readonly tenant: string;
  readonly slug: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly clientId: string;
  /** The `auth.json` item holding its secret. */
  readonly secretItem: string;
}

export interface V1Policy {
  readonly tenant: string;
  readonly id: string;
  readonly pattern: string;
  readonly action: string;
}

/**
 * What Executor 1 kept for an OpenAPI integration: its resolved specification, as a blob under
 * its `specHash`, and the operations it compiled from it, one tool each.
 */
export interface V1OpenApi {
  readonly tenant: string;
  readonly integration: string;
  readonly specHash: string;
  readonly spec: unknown;
  readonly operations: ReadonlyArray<{
    readonly tool: string;
    readonly method: string;
    readonly path: string;
  }>;
}

export interface V1LocalData {
  readonly integrations: readonly V1Integration[];
  readonly openapi?: readonly V1OpenApi[];
  readonly connections: readonly V1Connection[];
  readonly clients?: readonly V1OAuthClient[];
  readonly policies: readonly V1Policy[];
  /** `auth.json`: credential item id to value. */
  readonly credentials: Readonly<Record<string, string>>;
}

const schema = `
  create table integration (
    row_id text primary key, tenant text not null, slug text not null, plugin_id text not null,
    name text, description text, config blob, health_check blob, config_revised_at blob,
    created_at integer not null, updated_at integer not null
  );
  create table connection (
    row_id text primary key, tenant text not null, owner text not null, subject text not null,
    integration text not null, name text not null, template text not null,
    provider text not null, item_ids blob not null, oauth_client text,
    oauth_client_owner text, refresh_item_id text, expires_at blob, oauth_scope text,
    oauth_token_url text, tools_synced_at blob, created_at integer not null,
    updated_at integer not null
  );
  create table oauth_client (
    row_id text primary key, tenant text not null, owner text not null, subject text not null,
    slug text not null, authorization_url text not null, token_url text not null,
    "grant" text not null, client_id text not null, client_secret_item_id text, resource text,
    origin_kind text, origin_issuer text, origin_redirect_uri text,
    token_endpoint_auth_method text, created_at integer not null
  );
  create table tool_policy (
    row_id text primary key, tenant text not null, owner text not null, subject text not null,
    id text not null, pattern text not null, action text not null, position text not null,
    created_at integer not null, updated_at integer not null
  );
  create table tool (
    row_id text primary key, tenant text not null, owner text not null, subject text not null,
    integration text not null, connection text not null, plugin_id text not null,
    name text not null, description text, input_schema blob, output_schema blob,
    annotations blob, created_at integer not null, updated_at integer not null
  );
  create table blob (
    row_id text primary key, id text, namespace text not null, key text not null, value text
  );
  create table plugin_storage (
    row_id text primary key, tenant text not null, owner text not null, subject text not null,
    plugin_id text not null, collection text not null, key text not null, data blob,
    created_at integer not null, updated_at integer not null
  );
`;

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Write Executor 1's files into `directory`, in a running Executor 1's WAL mode. */
export const writeV1LocalData = (directory: string, data: V1LocalData) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* Effect.sync(() => {
      const database = new DatabaseSync(path.join(directory, "data.db"));
      try {
        database.exec("pragma journal_mode = wal;");
        database.exec(schema);
        const created = 1_788_000_000;
        const integration = database.prepare(
          `insert into integration values (?, ?, ?, ?, ?, null, ?, null, ?, ?, ?)`,
        );
        data.integrations.forEach((row, index) =>
          integration.run(
            `int_${index}`,
            row.tenant,
            row.slug,
            row.plugin,
            row.name,
            json(row.config),
            new TextEncoder().encode(String((created + index) * 1000)),
            created + index,
            created + index,
          ),
        );
        const connection = database.prepare(
          `insert into connection values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, null, null, ?, ?)`,
        );
        data.connections.forEach((row, index) => {
          const owner = row.owner ?? "org";
          connection.run(
            row.rowId,
            row.tenant,
            owner,
            owner === "org" ? "" : "local",
            row.integration,
            row.name,
            row.template,
            row.provider,
            json(row.items),
            row.oauth?.client ?? null,
            row.oauth?.refreshItem ?? null,
            row.oauth === undefined ? null : new TextEncoder().encode(String(row.oauth.expiresAt)),
            row.oauth?.scope ?? null,
            created + index,
            created + index,
          );
        });
        const client = database.prepare(
          `insert into oauth_client values (?, ?, 'org', '', ?, ?, ?, 'authorization_code', ?, ?, null, null, null, null, null, ?)`,
        );
        (data.clients ?? []).forEach((row, index) =>
          client.run(
            `client_${index}`,
            row.tenant,
            row.slug,
            row.authorizationUrl,
            row.tokenUrl,
            row.clientId,
            row.secretItem,
            created,
          ),
        );
        const policy = database.prepare(
          `insert into tool_policy values (?, ?, 'org', '', ?, ?, ?, ?, ?, ?)`,
        );
        data.policies.forEach((row, index) =>
          policy.run(
            `policy_${index}`,
            row.tenant,
            row.id,
            row.pattern,
            row.action,
            `a${index}`,
            created,
            created,
          ),
        );
        const blob = database.prepare(`insert into blob values (?, null, ?, ?, ?)`);
        const operation = database.prepare(
          `insert into plugin_storage values (?, ?, 'org', '', 'openapi', 'operation', ?, ?, ?, ?)`,
        );
        (data.openapi ?? []).forEach((entry, index) => {
          blob.run(
            `blob_${index}`,
            `o:${entry.tenant}/openapi`,
            `spec/${entry.specHash}`,
            JSON.stringify(entry.spec),
          );
          entry.operations.forEach((op, at) =>
            operation.run(
              `op_${index}_${at}`,
              entry.tenant,
              `${entry.integration}.${op.tool}`,
              json({
                integration: entry.integration,
                toolName: op.tool,
                binding: { method: op.method, pathTemplate: op.path },
              }),
              created,
              created,
            ),
          );
        });
      } finally {
        database.close();
      }
    });
    yield* fs.writeFileString(
      path.join(directory, "auth.json"),
      JSON.stringify(data.credentials, null, 2),
      { mode: 0o600 },
    );
  });

/**
 * Change Executor 1's tool policies after its files were written, as a person editing its rules
 * would: each policy replaces the one with its id, or is added after the others.
 */
export const writeV1Policies = (directory: string, policies: readonly V1Policy[]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    yield* Effect.sync(() => {
      const database = new DatabaseSync(path.join(directory, "data.db"));
      try {
        const remove = database.prepare(`delete from tool_policy where tenant = ? and id = ?`);
        const insert = database.prepare(
          `insert into tool_policy values (?, ?, 'org', '', ?, ?, ?, ?, 0, 0)`,
        );
        for (const policy of policies) {
          remove.run(policy.tenant, policy.id);
          insert.run(
            `policy_${policy.id}`,
            policy.tenant,
            policy.id,
            policy.pattern,
            policy.action,
            `z${policy.id}`,
          );
        }
      } finally {
        database.close();
      }
    });
  });
