/** Local PGlite driver composition and additive schema setup. */
import { makeExecutorStorage } from "@executor-js/sdk/core";
import { createDataStepJournal } from "@executor-js/app-management/data-steps";
import { startupPhase } from "./startup-diagnostics.ts";
import { localDatabase } from "./local-database.ts";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";
import * as Migrator from "effect/sql/Migrator";

/**
 * The accounts linked to each app's requirements, as hosted keeps them, without an organization or
 * an access policy: an app link has no `subject` and is used for every call and the app's
 * background work; a user link has the local subject, `local`. Links are keyed by requirement. A
 * plain requirement has at most one link per scope, kept by linking under the app's lock; many()
 * any number. Removing the app or the account removes its links, but an account with an app link
 * is refused first (`AccountLinkedToApp`, and the account removal hook). Local has one subject, so
 * no `linked_by` is kept.
 *
 * Profiles are converted once: each enabled profile that is not being removed links the existing
 * accounts it selected to the requirement it selected them for, as user links, dated by the oldest
 * such profile. A plain requirement links only the account it used, its first existing one, as SDK
 * 4.0.13 reads it. Profiles whose account set SDK 4.0.13 planned as a copy of the app are skipped;
 * data step `10_profile_app_copies` links their accounts to the copy.
 */
const appAccountLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table local_app_account_links (
    app text not null references executor_apps(id) on delete cascade,
    requirement text not null,
    subject text,
    account text not null references executor_accounts(id) on delete cascade,
    created_at timestamp with time zone not null default now()
  )`;
  yield* sql`create unique index local_app_account_links_app
    on local_app_account_links (app, requirement, account) where subject is null`;
  yield* sql`create unique index local_app_account_links_user
    on local_app_account_links (app, subject, requirement, account) where subject is not null`;
  yield* sql`create index local_app_account_links_account on local_app_account_links (account)`;
  yield* sql`insert into local_app_account_links (app, requirement, subject, account, created_at)
    select selected.app, selected.requirement, 'local', selected.account, min(selected.created_at)
      from (
        select i.app, i.created_at, b.key as requirement, a.id as account,
            row_number() over (partition by i.id, b.key order by e.ord) as position,
            case when d.requirements is null then jsonb_typeof(b.value) = 'string'
              else d.requirements::jsonb -> 'accounts' -> b.key ->> 'cardinality' = 'one' end
              as plain
          from executor_installations i
          join executor_apps app on app.id = i.app
          left join executor_deployments d on d.id = app.active_deployment
          cross join lateral jsonb_each(i.accounts::jsonb) b
          cross join lateral jsonb_array_elements_text(case jsonb_typeof(b.value)
              when 'array' then b.value
              when 'string' then jsonb_build_array(b.value)
              else '[]'::jsonb end) with ordinality e(account, ord)
          join executor_accounts a on a.id = e.account and a.owner = app.owner
          where i.enabled and i.status not in ('removing', 'removed')
            and not exists (select 1 from executor_profile_app_copies c,
              jsonb_array_elements_text(c.profiles::jsonb) listed(id) where listed.id = i.id)
      ) selected
      where selected.plain is not true or selected.position = 1
      group by selected.app, selected.requirement, selected.account
    on conflict do nothing`;
});

/**
 * The stdio MCP servers this server runs, one per app; see `stdio-mcp.ts`. `secrets` lists the
 * names of the variables the app's account supplies; their values are never stored here.
 * `token_digest` is the SHA-256 of the bridge token the account holds. A new table: the running
 * server never reads it, so creating it keeps that server online.
 *
 * Builds of this fork from before the fork journal ran this step as step 3, `stdio_mcp_servers`, in
 * `private_local_migrations`, so a database they opened has the table and that record. The record
 * is removed, so upstream's own step 3 still runs there; the table is kept with its rows.
 */
const stdioMcpServers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [journal] = yield* sql<{
    readonly exists: boolean;
  }>`select to_regclass('private_local_migrations') is not null as exists`;
  if (journal?.exists === true)
    yield* sql`delete from private_local_migrations
      where migration_id = 3 and name = 'stdio_mcp_servers'`;
  yield* sql`create table if not exists local_stdio_mcp_servers (
    id text primary key,
    app text not null unique references executor_apps(id) on delete cascade,
    command text not null,
    args jsonb not null,
    cwd text,
    env jsonb not null,
    secrets jsonb not null,
    token_digest text not null,
    created_at timestamp with time zone not null default now()
  )`;
});

/**
 * Local product tables beside the SDK schema, each applied once and recorded in the same SQL
 * transaction. Append new steps; never change one that has shipped.
 */
const migrateLocalProduct = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Effect's Postgres migrator probes with ::regclass; create its journal explicitly first.
  yield* sql`create table if not exists private_local_migrations (
    migration_id integer primary key,
    created_at timestamp with time zone not null default now(),
    name text not null
  )`;
  yield* Migrator.make({})({
    table: "private_local_migrations",
    loader: Migrator.fromRecord({
      "1_data_steps": createDataStepJournal("private_local"),
      // Runs after SDK 4.0.13, which keeps the profiles and plans their copies.
      "2_app_account_links": appAccountLinks,
    }),
  });
});

/**
 * This fork's own local tables, in a journal of their own. Upstream numbers the steps in
 * `private_local_migrations`, and Effect's migrator runs only steps above the highest it recorded,
 * so a fork step there would make a database skip upstream's step of the same number. These run
 * after the SDK schema and before upstream's local steps, so they may use SDK tables only. Append
 * new steps; never change one that has shipped.
 */
const migrateForkProduct = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Effect's Postgres migrator probes with ::regclass; create its journal explicitly first.
  yield* sql`create table if not exists private_local_fork_migrations (
    migration_id integer primary key,
    created_at timestamp with time zone not null default now(),
    name text not null
  )`;
  yield* Migrator.make({})({
    table: "private_local_fork_migrations",
    loader: Migrator.fromRecord({
      "1_stdio_mcp_servers": stdioMcpServers,
    }),
  });
});

/** Open persistent Effect SQL resources in the host scope and preserve existing records. */
export const openStorage = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const location = path.join(directory, "executor.pglite");
    yield* fs.makeDirectory(location, { recursive: true, mode: 0o700 });
    yield* fs.chmod(location, 0o700);
    const context = yield* Layer.build(localDatabase(location));
    const sql = Context.get(context, SqlClient.SqlClient);
    const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    yield* storage.migrate;
    // The fork's steps first: its first step returns upstream's step 3 to databases it took it in.
    yield* migrateForkProduct.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    yield* migrateLocalProduct.pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return { storage, sql };
  }).pipe(startupPhase("storage"));
