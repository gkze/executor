/**
 * Setup reads the accounts an app runs with in both scopes: the caller's own links and the app's
 * links for everyone. A manager who linked an account for everyone and none for themselves still
 * has that account connected, so the first prompt names it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { accountLinks, connectionsPath } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { Access } from "../support/hosted-app-accounts.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { scenarios } from "../test-plan.ts";

/** Datadog is the app's own account; Mail each member's, where many() needs none linked. */
const source = `import { defineApp, defineProvider, secrets, query, object, string, router, type QueryContext } from "apps";
const key = secrets({ label: "Key", fields: object({ token: string() }) });
const datadog = defineProvider({ name: "Datadog", auth: { key } });
const mail = defineProvider({ name: "Mail", auth: { key } });
const requirements = { app: { accounts: { datadog } }, user: { accounts: { mail: mail.many() } } };
const who = query({ input: object({}) }, async (ctx: QueryContext<typeof requirements>) => ctx.app.accounts.datadog.id);
export default defineApp(requirements, async () => ({ tools: router({ who }) }));`;

layer(HostedLive, { excludeTestServices: true })(
  "Setup with accounts linked for everyone",
  (it) => {
    it.effect(scenarios.hostedSharedAccountSetupPrompt.title, (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const api = yield* Api,
            actors = yield* Actors,
            browser = yield* Browser,
            evidence = yield* Evidence,
            oauth = yield* McpOAuth;
          const prefix = `/api/organizations/${actors.organization.id}`;
          const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Team report ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          });
          expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
          const app = yield* body(App, deployed);
          const path = `${prefix}/apps/${app.id}`;
          const accounts: string[] = [];
          // The app goes first: an account linked to it for everyone cannot be deleted.
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              yield* api.request(actors.owner, "DELETE", path);
              for (const account of accounts)
                yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
            }).pipe(Effect.orDie),
          );
          const access = yield* body(
            Access,
            yield* api.request(actors.owner, "GET", `${path}/access`),
          );
          expect(
            (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
              revision: access.revision,
              audience: { kind: "everyone" },
            })).status,
          ).toBe(200);

          // The owner links a Datadog account for everyone and links none for themselves.
          const label = `Team Datadog ${randomUUID().slice(0, 8)}`;
          const connection = yield* api.request(
            actors.owner,
            "POST",
            connectionsPath(path, "app", "datadog"),
            {},
          );
          expect(connection.status, JSON.stringify(connection.body)).toBe(200);
          const submitted = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/connections/${(yield* body(Resource, connection)).id}/submit`,
            { method: "key", label, fields: { token: `synthetic-${randomUUID()}` } },
          );
          expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
          const account = (yield* body(Resource, submitted)).id;
          accounts.push(account);
          expect(yield* accountLinks(actors.owner, path, "app")).toEqual([["datadog", account]]);
          expect(yield* accountLinks(actors.owner, path, "user")).toEqual([]);

          // Their assistant connects, and its first prompt names the app with that account.
          yield* browser.login(actors.owner);
          const grant = yield* oauth.authorize;
          const prompt = `/org/${actors.organization.slug}/setup/assistant?assistant=claude&step=prompt&agent=${encodeURIComponent(grant.grantId)}`;
          yield* browser.use("Open the first prompt", (page) => page.goto(prompt));
          // The copy button is labelled for the prompt only once the inventory has loaded.
          const text = yield* browser.use("Read the prompt once it names the accounts", (page) =>
            page
              .getByRole("button", { name: "Copy starter prompt", exact: true })
              .waitFor()
              .then(() =>
                page
                  .locator("p")
                  .filter({ hasText: /^Use Executor, which I connected over MCP at /u })
                  .innerText(),
              ),
          );
          expect(text).toContain(`I've connected `);
          expect(text).toContain(`${app.name} (${label})`);
          yield* browser.checkpoint("First prompt names the account linked for everyone");
          yield* evidence.attach(
            "first-prompt.png",
            "image/png",
            yield* browser.use("Capture the first prompt", (page) =>
              page.screenshot({ fullPage: true }),
            ),
          );
        }).pipe(Effect.provide(McpOAuth.layer)),
      ),
    );
  },
);
