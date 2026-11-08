/**
 * What one v1 item becomes in v2, decided from v1's rows and what the product's reader returns,
 * writing nothing: an integration's app source (its sign-in methods, approval rules and checks)
 * and the account a connection saves. Cloud's import and a local import both generate with it and
 * write the result through their own product.
 */
import {
  TemplateError,
  graphqlAppSource,
  generateMcpSource,
  openapiAppSource,
  type CredentialPlacement,
  type GeneratedAuthMethod,
  type GeneratedHealthCheck,
  type GeneratedToolRules,
} from "@executor-js/app-templates";
import {
  appSlug,
  appSlugFits,
  OAuthRegistration,
  SourceFiles,
  type AccountRequirement,
  type AuthMethodInvalid,
  type DeployedApp,
  type ImportOAuthGrant,
  type OAuthGrantNotImportable,
  type OAuthSetupFailed,
  type OwnerId,
  type VersionBuildFailed,
} from "@executor-js/sdk/core";
import { OpenapiCompileError, openapiOperationNames } from "apps/openapi";
import { Effect, Option, Predicate, Redacted, Schema } from "effect";
import { ItemFailed, itemFailed as fail, type V1StaleCategory } from "../contracts/index.ts";
import {
  credentialLike,
  itemOwner,
  mcpToolName,
  policyResolver,
  secretPrefix,
  toolkitAction,
  tokenEndpointAuthMethod,
  type ArtifactRow,
  tokenVariable,
  type V1AuthMethod,
  type ConnectionRow,
  type IntegrationRow,
  type OpenApiOperationRow,
  type PolicyAction,
  type ToolRow,
  type V1Rows,
} from "./formats.ts";
import { openapiHealth, v1IntrospectionQuery } from "./health.ts";
import {
  credentialOrigins,
  importedDocument,
  operationBaseUrls,
  parseSpec,
  plainHttpHosts,
  withoutOperations,
} from "./openapi.ts";
import {
  connectionPlan,
  decodedToolkits,
  integrationPlan,
  firstPartyName,
  firstPartyRefusal,
  integrationLabel,
  integrationValues,
  replaces,
  type ConfigSecret,
  type ConnectionPlan,
  type ImportableIntegration,
  type Unsupported,
} from "./plan.ts";
import type { V1ImportProduct } from "./product.ts";
import type { V1Reader } from "./reader.ts";
import {
  blockYamlDocument,
  type Entries,
  microsoftGraphFormat,
  parsedDocument,
} from "./stored-document.ts";
import { v1ToolPaths } from "./v1-tool-paths.ts";

/** The v1 rows a connection's account is decided from. */
export type ConnectionSnapshot = Pick<
  V1Rows,
  "tenant" | "subjects" | "integrations" | "connections" | "clients"
>;

/**
 * What a connection's account is decided from: the product's facts, v1's rows, and v1's credential
 * store, read only where a decision compares or copies a saved credential.
 */
export interface AccountContext<E> {
  readonly product: V1ImportProduct;
  readonly snapshot: ConnectionSnapshot;
  readonly source: Pick<V1Reader<E>, "secret">;
}

const failStale = (stale: V1StaleCategory, reason: string) =>
  Effect.fail(new ItemFailed({ reason, stale }));
/** Fail with a plan's refusal, keeping whether it is stale. */
export const refused = (plan: Unsupported) =>
  Effect.fail(
    new ItemFailed({ reason: plan.reason, ...(plan.stale === null ? {} : { stale: plan.stale }) }),
  );

// ---------------------------------------------------------------------------------------------
// Sign-in methods. One integration's app declares every method its connections use.

const methodKey = (method: GeneratedAuthMethod) => JSON.stringify(method);

/** A sign-in method and the values its account takes from v1's configuration, by field. */
interface PlannedMethod {
  readonly method: GeneratedAuthMethod;
  readonly configured: ReadonlyArray<readonly [string, string]>;
}

/**
 * Where an account sends the fixed credentials its method does not replace. v1 sent the fixed
 * values first and the connection's credentials over them, so a placement of the same name wins.
 */
const fixedPlacements = (
  secrets: readonly ConfigSecret[],
  own: readonly { readonly carrier: "header" | "query"; readonly name: string }[],
) => {
  const sent = secrets.filter((secret) => !own.some((placement) => replaces(placement, secret)));
  return {
    placements: sent.map((secret): CredentialPlacement => ({
      carrier: secret.carrier,
      name: secret.name,
      field: secret.field,
    })),
    configured: sent.map((secret) => [secret.field, secret.value] as const),
  };
};

/**
 * The method a connection signs in with, or undefined for one that sends no credentials. An API
 * key's literal values and prefixes that hold a credential become fields like the fixed
 * credentials in `secrets`, which its account also holds.
 */
const plannedMethod = (
  plan: ConnectionPlan,
  secrets: readonly ConfigSecret[],
): PlannedMethod | undefined => {
  const access = plan.access;
  switch (access.kind) {
    case "none":
      return undefined;
    case "secrets": {
      const configured: Array<readonly [string, string]> = [];
      const placements = access.placements.map((placement): CredentialPlacement => {
        const prefixed =
          placement.prefix !== undefined && secretPrefix(placement.prefix)
            ? { prefixField: `${placement.name} prefix` }
            : { prefix: placement.prefix };
        if (prefixed.prefixField !== undefined && placement.prefix !== undefined)
          configured.push([prefixed.prefixField, placement.prefix]);
        if (placement.literal === undefined)
          return {
            carrier: placement.carrier,
            name: placement.name,
            ...prefixed,
            field: placement.variable ?? "token",
          };
        if (!credentialLike(placement.name, placement.literal))
          return {
            carrier: placement.carrier,
            name: placement.name,
            ...prefixed,
            literal: placement.literal,
          };
        const field = `${placement.carrier} ${placement.name}`;
        configured.push([field, placement.literal]);
        return { carrier: placement.carrier, name: placement.name, ...prefixed, field };
      });
      const fixed = fixedPlacements(secrets, access.placements);
      const all = [...configured, ...fixed.configured];
      return {
        method: {
          kind: "secrets",
          label: "API key",
          fields: [
            ...new Set([
              ...access.items.map(([variable]) => variable),
              ...all.map(([field]) => field),
            ]),
          ],
          placements: [...placements, ...fixed.placements],
        },
        configured: all,
      };
    }
    case "oauth": {
      // v1 signed in at the connection's client's endpoints with the method's scopes, or the ones
      // its authorization URL set, so a reconnect does too; connections whose clients differ get a
      // method each. The account's grant renews as v1 did (`renewal`).
      const { method, client } = access;
      const scopes = [...method.scopes];
      const resource =
        client.resource === null || client.resource === "" ? {} : { resource: client.resource };
      const oauth =
        access.grant === "client_credentials"
          ? {
              grant: "client_credentials",
              tokenUrl: client.token_url,
              scopes,
              tokenEndpointAuthMethod: access.authentication,
              ...resource,
            }
          : access.authorization.kind === "discover"
            ? {
                discover: access.authorization.url,
                ...(scopes.length === 0 ? {} : { scopes }),
              }
            : {
                authorizationUrl: access.authorization.authorizationUrl,
                tokenUrl: client.token_url,
                scopes: [...access.authorization.scopes],
                ...resource,
              };
      // The fixed credentials go in the app's fixed account (`appMethods`).
      return {
        method: { kind: "oauth", oauth, header: method.header, prefix: method.prefix },
        configured: [],
      };
    }
    case "first_party": {
      // v1 signed in at its own app's endpoints, which v2's client of the same name has. The
      // method declares them, so v2 signs it in, renews it and reconnects it with that client;
      // an MCP server names them itself. Its scopes are what v1 asked that app for. A client
      // that allows no scopes (the GitHub App's) asks for none, so an MCP method says so: left
      // to discovery, it would ask for the scopes the server advertises (GitHub's MCP server
      // lists `repo`, `gist` and more), and such a client is not offered for those.
      const { method, client, scopes } = access;
      const oauth =
        plan.decoded.plugin === "mcp"
          ? {
              discover: plan.decoded.config.endpoint,
              ...(scopes.length === 0 && (client.allowedScopes ?? client.defaultScopes).length > 0
                ? {}
                : { scopes: [...scopes] }),
            }
          : {
              authorizationUrl: client.server.authorizationUrl,
              tokenUrl: client.server.tokenUrl,
              scopes: [...scopes],
            };
      return {
        method: { kind: "oauth", oauth, header: method.header, prefix: method.prefix },
        configured: [],
      };
    }
  }
};

/**
 * A fixed credential the app leaves out: its value is the client ID or client secret of the OAuth
 * client one of the integration's connections signs in with, which that sign-in already sends
 * (decision 22).
 */
export interface DroppedFixed {
  readonly secret: ConfigSecret;
  readonly reason: "oauth_client_id" | "oauth_client_secret";
}

/**
 * The integration's fixed credentials that repeat one of its OAuth connections' own client ID or
 * client secret, as when a client's credentials were pasted as headers. A client secret is read
 * from v1's Vault as the connection's import reads it, compared in memory and kept nowhere.
 */
const redundantFixed = <E>(context: AccountContext<E>, integration: IntegrationRow) =>
  Effect.gen(function* () {
    const decoded = integrationPlan(context.product, integration);
    if (!decoded.ok) return [];
    const { secrets } = integrationValues(decoded.value);
    if (secrets.length === 0) return [];
    const clients: Array<{ readonly id: string; readonly secret: string | undefined }> = [];
    for (const row of context.snapshot.connections) {
      if (row.integration !== integration.slug) continue;
      const plan = connectionPlan(context.product, context.snapshot, row);
      if (!plan.ok) continue;
      const access = plan.value.access;
      if (access.kind === "first_party")
        clients.push({ id: access.client.clientId, secret: undefined });
      else if (access.kind === "oauth") {
        const item = access.client.client_secret_item_id;
        const secret =
          item === null
            ? undefined
            : yield* readSecret(context, row, item).pipe(
                Effect.map((value) => Option.some(Redacted.value(value))),
                // The reader's own error `E` is generic, which `catchTag` cannot narrow.
                Effect.catchIf(
                  (error): error is ItemFailed => error instanceof ItemFailed,
                  (failed) =>
                    failed.credential === "unavailable"
                      ? Effect.fail(failed)
                      : Effect.succeed(Option.none<string>()),
                ),
                Effect.map(Option.getOrUndefined),
              );
        clients.push({ id: access.client.client_id, secret });
      }
    }
    return secrets.flatMap((secret): DroppedFixed[] => {
      if (clients.some((client) => client.id !== "" && client.id === secret.value))
        return [{ secret, reason: "oauth_client_id" }];
      if (clients.some((client) => client.secret !== undefined && client.secret === secret.value))
        return [{ secret, reason: "oauth_client_secret" }];
      return [];
    });
  });

/** The fields of fixed credentials an app leaves out. */
const droppedFields = (dropped: readonly DroppedFixed[]) =>
  new Set(dropped.map((entry) => entry.secret.field));

/** The plans of the integration's connections that move: those whose sign-in v2 can take. */
export const connectionPlans = (
  product: V1ImportProduct,
  snapshot: ConnectionSnapshot,
  integration: Pick<IntegrationRow, "slug">,
) =>
  snapshot.connections
    .filter((row) => row.integration === integration.slug)
    .flatMap((row) => {
      const plan = connectionPlan(product, snapshot, row);
      return plan.ok ? [plan.value] : [];
    });

/**
 * The v1 rows a connection's own app is decided from (decision 33): its integration's other
 * connections left out, so the app takes only its sign-in method and account.
 */
export const connectionSnapshot = <S extends Pick<V1Rows, "connections">>(
  snapshot: S,
  connection: Pick<ConnectionRow, "row_id" | "integration">,
): S => ({
  ...snapshot,
  connections: snapshot.connections.filter(
    (row) => row.integration !== connection.integration || row.row_id === connection.row_id,
  ),
});

/**
 * An app name the importer makes, in parts: fixed text, and text it may shorten (`{ cut }`). The
 * fixed text tells apps apart whose other text is the same, such as a connection's number.
 */
export type AppNaming = readonly (string | { readonly cut: string })[];

/** The names the importer tries for one app before it gives up (`wording.namesTaken`). */
const nameAttempts = 5;

/** The longest app name (`AppName`). */
const nameLength = 120;

/** Spaces and punctuation that would dangle before a shortened text's "…". */
const dangling = /[\s\p{Ps}\p{Pd}\p{Po}]+$/u;

/** `text` shortened with "…", longest first: at each word, then at each character. */
const shortenings = (text: string) => {
  const characters = Array.from(text);
  const words = [...text.matchAll(/\s+/gu)].map((match) => text.slice(0, match.index)).reverse();
  const cuts = characters.map((_, end) => characters.slice(0, end).join("")).reverse();
  return [...words, ...cuts].map((kept) => `${kept.replace(dangling, "")}…`);
};

/**
 * The name the importer gives an app on its `attempt`: `naming`'s parts, then on a retry
 * `(v1 <attempt>)`. An app's address keeps only the start of a long name (`appSlugFits`), so a
 * name with fixed text keeps it whole and shortens the other parts, the first first, until its
 * address holds the whole name. A name that already fits stays as it is. A name of only text it
 * may shorten has nothing to tell apart, and only keeps to the length names may have.
 */
const appName = (naming: AppNaming, attempt: number) => {
  const parts = attempt === 1 ? naming : [...naming, ` (v1 ${attempt})`];
  const tellsApart = parts.some((part) => typeof part === "string");
  const fits = (texts: readonly string[]) => {
    const name = texts.join("");
    return name.length <= nameLength && (!tellsApart || appSlugFits(name));
  };
  let texts = parts.map((part) => (typeof part === "string" ? part : part.cut));
  for (const [index, part] of parts.entries()) {
    if (fits(texts)) break;
    if (typeof part === "string") continue;
    texts =
      shortenings(part.cut)
        .map((cut) => texts.with(index, cut))
        .find(fits) ?? texts.with(index, "…");
  }
  return texts.join("");
};

/**
 * The names the importer tries for an app, in order: its own, then retries numbered `(v1 N)`. Each
 * has an address of its own, so a retry never tries an address already refused.
 */
export const appNames = (naming: AppNaming) =>
  Array.from({ length: nameAttempts }, (_, index) => appName(naming, index + 1)).filter(
    (name, index, names) => names.findIndex((other) => appSlug(other) === appSlug(name)) === index,
  );

/**
 * Create an app under the first of its names (`appNames`) no other app has, by name or address.
 * `create` makes it under one name and fails with `AppNameTaken` or `AppSlugTaken` when another
 * app has it; when every name is taken the item is refused with the product's `namesTaken`.
 */
export const createNamed = <A, E, R>(
  product: Pick<V1ImportProduct, "wording">,
  naming: AppNaming,
  create: (name: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    for (const name of appNames(naming)) {
      const created = yield* create(name).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          (error) =>
            Predicate.isTagged(error, "AppNameTaken") || Predicate.isTagged(error, "AppSlugTaken"),
          () => Effect.succeed(Option.none<A>()),
        ),
      );
      if (Option.isSome(created)) return created.value;
    }
    return yield* fail(product.wording.namesTaken);
  });

/**
 * Why a generated app did not build, which names its stage and the failure in the generated
 * source, never a credential. The same rows generate the same source, so it is refused, not
 * retried.
 */
export const buildFailed = (error: Pick<VersionBuildFailed, "message">) =>
  new ItemFailed({ reason: `The generated app did not build. ${error.message}` });

/** An integration's one app's name: its label. */
export const integrationNaming = (integration: IntegrationRow): AppNaming => [
  { cut: integrationLabel(integration) },
];

/** An artifact's app's name: its title. */
export const artifactNaming = (row: Pick<ArtifactRow, "title">): AppNaming => [
  { cut: row.title.trim() === "" ? "Artifact" : row.title },
];

/**
 * A connection's own app's name (decision 33): its integration's, then the connection's. A
 * workspace connection that shares its name with a member's says so, as its account does. App
 * names are unique in an organization, and members often gave their connections the same name, so
 * each later connection of a name is numbered, in the order v1 made them. When the name is too
 * long for its address to hold, the integration's label is shortened first, then the connection's
 * name; the marker and number stay whole (`appName`).
 */
export const connectionAppNaming = (
  snapshot: Pick<V1Rows, "connections">,
  integration: IntegrationRow,
  connection: ConnectionRow,
): AppNaming => {
  const nameOf = (row: ConnectionRow) =>
    row.name.trim() === "" ? "connection" : row.name.trim().slice(0, 56);
  const own = (row: ConnectionRow) =>
    accountLabel(snapshot, row) === row.name ? nameOf(row) : `${nameOf(row)}, workspace`;
  const base = own(connection);
  const index = snapshot.connections
    .filter((row) => row.integration === connection.integration && own(row) === base)
    .sort((a, b) =>
      a.created_ms !== b.created_ms
        ? a.created_ms - b.created_ms
        : a.row_id < b.row_id
          ? -1
          : a.row_id > b.row_id
            ? 1
            : 0,
    )
    .findIndex((row) => row.row_id === connection.row_id);
  const marker = base === nameOf(connection) ? "" : ", workspace";
  return [
    { cut: integrationLabel(integration) },
    " (",
    { cut: nameOf(connection) },
    `${marker}${index > 0 ? ` ${index + 1}` : ""})`,
  ];
};

/** A connection's own app's name, as its first deploy tries it (`connectionAppNaming`). */
export const connectionAppName = (
  snapshot: Pick<V1Rows, "connections">,
  integration: IntegrationRow,
  connection: ConnectionRow,
) => appName(connectionAppNaming(snapshot, integration, connection), 1);

/** An item context narrowed to one connection's own app (decision 33). */
export const connectionContext = <C extends { readonly snapshot: ConnectionSnapshot }>(
  context: C,
  connection: ConnectionRow,
) => ({ ...context, snapshot: connectionSnapshot(context.snapshot, connection), connection });

/**
 * The app's sign-in methods, which one each importable connection uses, and the values each
 * account takes from v1's configuration. When the app takes accounts at all (another connection
 * signs in, or the integration sends fixed credentials), a connection that sent no credentials of
 * its own gets a method with only the fixed ones: "No credentials" when there are none.
 *
 * An OAuth account holds only its token, so when an OAuth connection's integration sends fixed
 * credentials its sign-in does not replace, the app holds every fixed credential in one more
 * account, linked for everyone (`fixed`, decision 22), and no method holds them. Fixed credentials
 * in `dropped` are left out.
 */
const appMethods = (
  product: V1ImportProduct,
  snapshot: ConnectionSnapshot,
  integration: IntegrationRow,
  dropped: readonly DroppedFixed[],
) => {
  const methods: Record<string, GeneratedAuthMethod> = {};
  const keys = new Map<string, string>();
  const methodOf = new Map<string, string>();
  const configured = new Map<string, ReadonlyArray<readonly [string, string]>>();
  const plans = connectionPlans(product, snapshot, integration);
  const decoded = integrationPlan(product, integration);
  const secrets = decoded.ok
    ? integrationValues(decoded.value, droppedFields(dropped)).secrets
    : [];
  const needsFixed = plans.some((plan) => {
    const access = plan.access;
    return (
      (access.kind === "oauth" || access.kind === "first_party") &&
      secrets.some((secret) => !replaces({ carrier: "header", name: access.method.header }, secret))
    );
  });
  const all = fixedPlacements(secrets, []);
  const fixed = needsFixed
    ? {
        account: { fields: all.configured.map(([field]) => field), placements: all.placements },
        configured: all.configured,
      }
    : undefined;
  // With a fixed account, the methods' accounts hold none of the fixed credentials.
  const methodSecrets = fixed === undefined ? secrets : [];
  const add = (plan: ConnectionPlan, planned: PlannedMethod) => {
    configured.set(plan.row.row_id, planned.configured);
    const key = methodKey(planned.method);
    const existing = keys.get(key);
    if (existing !== undefined) {
      methodOf.set(plan.row.row_id, existing);
      return;
    }
    // v1 accepted a connection with an empty template slug; a method needs a name.
    const template = plan.row.template === "" ? plan.access.kind : plan.row.template;
    const base =
      plan.access.kind === "oauth" && plan.access.grant === "client_credentials"
        ? `${template}_client_credentials`
        : template;
    let name = base;
    for (let number = 2; Object.hasOwn(methods, name); number++) name = `${base}_${number}`;
    methods[name] = planned.method;
    keys.set(key, name);
    methodOf.set(plan.row.row_id, name);
  };
  for (const plan of plans) {
    const planned = plannedMethod(plan, methodSecrets);
    if (planned !== undefined) add(plan, planned);
  }
  if (Object.keys(methods).length > 0 || methodSecrets.length > 0) {
    const none = fixedPlacements(methodSecrets, []);
    const method: GeneratedAuthMethod = {
      kind: "secrets",
      label: methodSecrets.length === 0 ? "No credentials" : "Fixed credentials",
      fields: none.configured.map(([field]) => field),
      placements: none.placements,
    };
    for (const plan of plans)
      if (plan.access.kind === "none") add(plan, { method, configured: none.configured });
    // Fixed credentials without a connection still make the app take an account that holds them.
    if (Object.keys(methods).length === 0) methods.none = method;
  }
  // When only the fixed-credentials method came from v1's rows, and the product declares an
  // integration's own methods, those replace it, each also holding the fixed values, as v1 sent
  // them with every connection.
  const onlyFixed =
    Object.keys(methods).length === 0 ||
    (Object.keys(methods).length === 1 && methods.none !== undefined && methodOf.size === 0);
  if (product.declaredMethods && onlyFixed && decoded.ok) {
    const extra = fixedPlacements(methodSecrets, []);
    const withFixed: Record<string, GeneratedAuthMethod> = {};
    for (const [slug, method] of decoded.value.methods) {
      const generated = declaredMethod(decoded.value, method);
      if (generated === undefined || Object.hasOwn(withFixed, slug)) continue;
      if (generated.kind === "secrets")
        withFixed[slug] = {
          ...generated,
          fields: [...generated.fields, ...extra.configured.map(([field]) => field)],
          placements: [...generated.placements, ...extra.placements],
        };
      // An OAuth method's account holds no fixed values, so declare one only when there are none.
      else if (methodSecrets.length === 0) withFixed[slug] = generated;
    }
    if (Object.keys(withFixed).length > 0) {
      delete methods.none;
      Object.assign(methods, withFixed);
    }
  }
  // Org connections become accounts linked for everyone where the product shares them, so the app
  // also takes those (decision 9).
  const shared = plans.some(
    (plan) =>
      accountRequirement(product, plan.row) === sharedRequirement && methodOf.has(plan.row.row_id),
  );
  return { methods, methodOf, configured, plans, shared, fixed, dropped };
};

/**
 * What an integration's app takes, decided from the context's rows: its sign-in methods, which one
 * each connection's account uses, and its fixed account. Narrowed to one connection
 * (`connectionContext`), it is that connection's own app (decision 33).
 */
export const appAccounts = <E>(context: AccountContext<E>, integration: IntegrationRow) =>
  Effect.gen(function* () {
    const dropped = yield* redundantFixed(context, integration);
    return appMethods(context.product, context.snapshot, integration, dropped);
  });

/**
 * A sign-in method as the integration declared it, for an app none of whose connections moved:
 * an API key's placements, or OAuth at the endpoints it declared (OpenAPI) or discovers (MCP).
 * GraphQL OAuth read its endpoints from a connection's client, so it has none to declare.
 */
const declaredMethod = (
  decoded: ImportableIntegration,
  method: V1AuthMethod,
): GeneratedAuthMethod | undefined => {
  switch (method.kind) {
    case "apikey": {
      const fields = new Set<string>();
      const placements = method.placements.flatMap((placement): CredentialPlacement[] => {
        if (placement.literal !== undefined)
          return credentialLike(placement.name, placement.literal)
            ? []
            : [{ carrier: placement.carrier, name: placement.name, literal: placement.literal }];
        const field = placement.variable ?? tokenVariable;
        fields.add(field);
        return [
          { carrier: placement.carrier, name: placement.name, prefix: placement.prefix, field },
        ];
      });
      return fields.size === 0
        ? undefined
        : { kind: "secrets", label: method.label ?? "API key", fields: [...fields], placements };
    }
    case "oauth2": {
      if (method.enterprise) return undefined;
      const oauth =
        decoded.plugin === "mcp"
          ? {
              discover: decoded.config.endpoint,
              ...(method.scopes.length === 0 ? {} : { scopes: [...method.scopes] }),
            }
          : method.authorizationUrl !== undefined && method.tokenUrl !== undefined
            ? {
                authorizationUrl: method.authorizationUrl,
                tokenUrl: method.tokenUrl,
                scopes: [...method.scopes],
              }
            : undefined;
      return oauth === undefined
        ? undefined
        : { kind: "oauth", oauth, header: method.header, prefix: method.prefix };
    }
    default:
      return undefined;
  }
};

/** What an integration's app takes, as `appAccounts` plans it. */
export type AppAccounts = ReturnType<typeof appMethods>;

// ---------------------------------------------------------------------------------------------
// Tool names and approvals.

const rank = { approve: 1, default: 1.5, require_approval: 2, block: 3 } as const;
/**
 * What v1 did with a tool no policy decided, when the app's own default would not do the same: ask,
 * for an MCP tool whose row v1 stamped as needing approval. v1 asked from that stamp, made from the
 * server's `destructiveHint` when it last listed the tools; the app's default reads the live hint,
 * which a server may have dropped since, so the app asks always. OpenAPI and GraphQL defaults
 * come from the generated source (a method or a mutation), which asks wherever v1 stamped one.
 * A tool v1 did not stamp keeps the app's default.
 */
const unruled = (integration: Pick<IntegrationRow, "plugin_id">, tool: ToolRow) =>
  integration.plugin_id === "mcp" && tool.requires_approval ? "require_approval" : "default";
/**
 * Each tool's v1 policy result, combined across its connections and the v1 names it had: the most
 * restrictive, where a connection without a matching policy keeps the tool's own default, pinned
 * as `unruled` says. `aliases` maps a dropped v1 name to the name the tool keeps.
 *
 * A toolkit's own policies applied only to calls through the toolkit, and v1 ignored the
 * workspace's policies there, but v2 keeps approvals in the app for every caller. A toolkit that
 * asks before a tool it grants therefore makes the app ask. One that grants it without a rule of its
 * own left it to the tool's default, so the workspace's `approve` cannot lower it below that
 * default either. The toolkit's `approve` never lowers the workspace's result, and its `block` only
 * leaves the tool out of the toolkit's connection.
 */
export const toolActions = (
  snapshot: V1Rows,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
) => {
  const actions = new Map<string, PolicyAction | "default">();
  const toolkits = decodedToolkits(snapshot);
  const resolve = policyResolver(snapshot.policies, snapshot.multiMember);
  for (const tool of tools) {
    const id = `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`;
    const fallback = unruled(integration, tool);
    const own = resolve(id) ?? fallback;
    // The least the app may do for each toolkit that grants the tool: ask when the toolkit asks,
    // keep the tool's default when the toolkit left it to the default.
    const action = toolkits.reduce<PolicyAction | "default">((current, toolkit) => {
      const granted = toolkitAction(toolkit, id);
      const floor =
        granted === "require_approval" ? granted : granted === "default" ? fallback : undefined;
      return floor !== undefined && rank[floor] > rank[current] ? floor : current;
    }, own);
    const name = Object.hasOwn(aliases, tool.name) ? (aliases[tool.name] ?? tool.name) : tool.name;
    const current = actions.get(name);
    if (current === undefined || rank[action] > rank[current]) actions.set(name, action);
  }
  return actions;
};

/** The app's own rules from each tool's action: left out, `never` or `always`. */
export const approvalRules = (actions: ReadonlyMap<string, PolicyAction | "default">) => {
  const approvals: Record<string, "always" | "never"> = {};
  const omitted: string[] = [];
  for (const [name, action] of actions) {
    if (action === "block") omitted.push(name);
    else if (action === "approve") approvals[name] = "never";
    else if (action === "require_approval") approvals[name] = "always";
  }
  return { approvals, omitted };
};

/** A tool name no tool row has: only a rule's `*` in the tool's place matches it. */
const unlistedName = "\u0000";

/** Where v1 listed a tool: its connection's owner, member and name, as in v1's tool ids. */
type ToolAddress = Pick<ToolRow, "owner" | "subject" | "connection">;

const addressOf = (connection: Pick<ConnectionRow, "owner" | "subject" | "name">): ToolAddress => ({
  owner: connection.owner,
  subject: connection.subject,
  connection: connection.name,
});

/** Each of the integration's connections, and one made later in either scope. */
const integrationAddresses = (
  snapshot: Pick<V1Rows, "connections">,
  integration: Pick<IntegrationRow, "slug">,
): readonly ToolAddress[] => [
  ...snapshot.connections
    .filter((connection) => connection.integration === integration.slug)
    .map(addressOf),
  { owner: "org", subject: "", connection: unlistedName },
  { owner: "user", subject: "", connection: unlistedName },
];

/**
 * Rows for tools v1 had no row for, as a connection at each address would list them. v1 decided
 * such a tool by its rules once a connection listed it, so the app decides it the same way.
 */
const unlistedRows = (
  addresses: readonly ToolAddress[],
  names: Iterable<string>,
): readonly ToolRow[] =>
  [...names].flatMap((name) =>
    addresses.map((address) => ({
      ...address,
      name,
      upstream: name,
      requires_approval: false,
      listed_at: null,
    })),
  );

/**
 * The integration's tools as one connection alone lists them: a row at its address for each name
 * any of its connections listed. A tool asks by default when v1 stamped any of its rows, so
 * connections that listed it at different times do not differ by their stamps.
 */
export const listedAs = (
  connection: Pick<ConnectionRow, "owner" | "subject" | "name">,
  tools: readonly ToolRow[],
): readonly ToolRow[] => {
  const byName = new Map<string, ToolRow>();
  for (const tool of tools) {
    const known = byName.get(tool.name);
    if (known === undefined || (tool.requires_approval && !known.requires_approval))
      byName.set(tool.name, tool);
  }
  return [...byName.values()].map((tool) => ({ ...tool, ...addressOf(connection) }));
};

/** The tool names the workspace's and toolkits' rules for an integration spell out in full. */
const ruleNames = (snapshot: V1Rows, integration: Pick<IntegrationRow, "slug">) => {
  const names = new Set<string>();
  const patterns = [
    ...snapshot.policies.map((policy) => policy.pattern),
    ...decodedToolkits(snapshot).flatMap((toolkit) =>
      toolkit.policies.map((policy) => policy.pattern),
    ),
  ];
  for (const pattern of patterns) {
    const segments = pattern.split(".");
    if (segments[0] !== integration.slug || segments.length < 4) continue;
    const name = segments.slice(3);
    if (!name.includes("*")) names.add(name.join("."));
  }
  return names;
};

/**
 * v1's result for each name `v1ToolRules` decides, and, on a server that lists tools as it runs
 * (no `exposed`), the result v1's rules give a name none of them spells out (`unnamed`). With a
 * `connection`, the results are v1's for that connection alone (decision 33).
 */
export const v1ToolDecisions = (
  snapshot: V1Rows,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
  exposed?: readonly string[],
  connection?: Pick<ConnectionRow, "owner" | "subject" | "name">,
) => {
  const rows = connection === undefined ? tools : listedAs(connection, tools);
  const addresses =
    connection === undefined
      ? integrationAddresses(snapshot, integration)
      : [addressOf(connection)];
  const listed = toolActions(snapshot, integration, rows, aliases);
  const unlisted = new Set(
    [...ruleNames(snapshot, integration), ...(exposed ?? [])].filter(
      (name) => !listed.has(name) && !Object.hasOwn(aliases, name),
    ),
  );
  const actions: ReadonlyMap<string, PolicyAction | "default"> = new Map([
    ...listed,
    ...toolActions(snapshot, integration, unlistedRows(addresses, unlisted)),
  ]);
  const unnamed =
    exposed === undefined
      ? toolActions(snapshot, integration, unlistedRows(addresses, [unlistedName])).get(
          unlistedName,
        )
      : undefined;
  return { actions, unnamed };
};

/**
 * The app's rules from v1's policies: each tool v1 listed (`toolActions`), each tool a rule names
 * that v1 did not list, such as one the server stopped listing, and each name in `exposed`. v1
 * decided a tool it listed later by the same rules, so none of these runs with less than v1 gave
 * it. `exposed` is every name the app can expose, when its source fixes them (OpenAPI); otherwise
 * the server lists tools as it runs, and a tool no rule names gets what v1's rules give a tool
 * they do not name (`otherwise`). With a `connection`, the rules are v1's for it alone.
 */
export const v1ToolRules = (
  snapshot: V1Rows,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
  exposed?: readonly string[],
  connection?: Pick<ConnectionRow, "owner" | "subject" | "name">,
): Pick<GeneratedToolRules, "approvals" | "omitted" | "otherwise"> => {
  const { actions, unnamed } = v1ToolDecisions(
    snapshot,
    integration,
    tools,
    aliases,
    exposed,
    connection,
  );
  const rules = approvalRules(actions);
  if (exposed !== undefined) return rules;
  const rule =
    unnamed === "block" ? "omitted" : unnamed === "require_approval" ? "always" : undefined;
  return rule === undefined
    ? rules
    : { ...rules, otherwise: { rule, known: [...actions.keys()].sort() } };
};

/**
 * Whether v1 decided a tool differently for two of the integration's connections (decision 33):
 * one a connection listed, a rule names or the app exposes, or, on a server that lists its tools as
 * it runs, one no rule names. Each connection's results are v1's for it alone, toolkits' included,
 * so any difference in blocking, asking, allowing or the tool's default counts.
 */
export const rulesDiffer = (
  snapshot: V1Rows,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  connections: ReadonlyArray<Pick<ConnectionRow, "owner" | "subject" | "name">>,
  aliases: Readonly<Record<string, string>> = {},
  exposed?: readonly string[],
) => {
  const [first, ...rest] = connections.map((connection) =>
    v1ToolDecisions(snapshot, integration, tools, aliases, exposed, connection),
  );
  return (
    first !== undefined &&
    rest.some(
      (other) =>
        other.unnamed !== first.unnamed ||
        [...first.actions].some(([name, action]) => other.actions.get(name) !== action),
    )
  );
};

/** How many tools an app's rules leave out, ask before and run without asking, as reported. */
export interface RuleCounts {
  readonly omitted: number;
  readonly always: number;
  readonly never: number;
  /** What the rules do with a tool none of them names, on a server that lists tools as it runs. */
  readonly otherwise: "omitted" | "always" | null;
}

const ruleCounts = (
  rules: Pick<GeneratedToolRules, "approvals" | "omitted" | "otherwise">,
): RuleCounts => {
  const approvals = Object.values(rules.approvals ?? {});
  return {
    omitted: rules.omitted?.length ?? 0,
    always: approvals.filter((rule) => rule === "always").length,
    never: approvals.filter((rule) => rule === "never").length,
    otherwise: rules.otherwise?.rule ?? null,
  };
};

const missingNames = (missing: readonly string[]) =>
  `v2 would not provide ${missing.length} of its v1 tools: ${missing
    .slice(0, 10)
    .join(", ")}${missing.length > 10 ? ", …" : ""}.`;

/**
 * Whether v1 renamed an MCP server's tools, the upstream names v1 numbered, the v1 names dropped
 * as aliases, and the v1 names the generated app cannot reproduce. v1's id is the lower snake case
 * name, numbered from `_2` when an earlier tool of the same listing took it; the app maps each
 * numbered name explicitly. v1 sometimes listed one upstream tool under two names; it is kept once,
 * under its lower snake case name, and the other names are aliases (`alias → kept name`). A tool
 * row without the server's own name fails every call in v1 until it lists again, so it is skipped.
 */
export const mcpNaming = (rows: readonly ToolRow[]) => {
  const tools = rows.flatMap((tool) =>
    tool.upstream === null ? [] : [{ ...tool, upstream: tool.upstream }],
  );
  const rename = tools.some((tool) => tool.upstream !== tool.name);
  const exposed = (upstream: string) => (rename ? mcpToolName(upstream) : upstream);
  const overrides: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const missing = new Set<string>();
  // A name another upstream tool takes in lower snake case belongs to that tool.
  const takenByOther = (upstream: string, name: string) =>
    tools.some((other) => other.upstream !== upstream && exposed(other.upstream) === name);
  const upstreams = new Map<string, Set<string>>();
  for (const tool of tools)
    upstreams.set(tool.upstream, (upstreams.get(tool.upstream) ?? new Set()).add(tool.name));
  for (const [upstream, names] of upstreams) {
    const base = exposed(upstream);
    if (names.size > 1) {
      for (const name of names)
        if (name === base) continue;
        else if (takenByOther(upstream, base)) missing.add(name);
        else aliases[name] = base;
      continue;
    }
    for (const name of names) {
      if (base === name) continue;
      const numbered =
        rename &&
        name.startsWith(`${base}_`) &&
        /^[0-9]+$/u.test(name.slice(base.length + 1)) &&
        !takenByOther(upstream, name);
      if (numbered) overrides[upstream] = name;
      else missing.add(name);
    }
  }
  return { rename, overrides, aliases, missing: [...missing] };
};

/** v1 GraphQL names that are not `query.<field>` or `mutation.<field>`. */
export const graphqlMissing = (tools: readonly ToolRow[]) => [
  ...new Set(
    tools
      .filter((tool) => !/^(query|mutation)\.[A-Za-z_][A-Za-z0-9_]*$/u.test(tool.name))
      .map((tool) => tool.name),
  ),
];

const toolNames = (tools: readonly ToolRow[]) => new Set(tools.map((tool) => tool.name));

/**
 * v1's compiled name, by method and document path, for each operation v1 bound without a stored
 * row: a tool it last listed but stored no binding for, which v1 found by compiling the document.
 * An integration with neither rows nor listed tools exposes every operation, as v1 listed for a
 * new connection.
 */
export const compiledTools = (
  document: Entries,
  operations: readonly OpenApiOperationRow[],
  tools: readonly ToolRow[],
): ReadonlyMap<string, string> => {
  const bound = new Set(operations.map((operation) => operation.tool));
  const listed = toolNames(tools);
  const unbound = [...listed].filter((tool) => !bound.has(tool));
  if (operations.length > 0 && unbound.length === 0) return new Map();
  const wanted = operations.length === 0 && listed.size === 0 ? undefined : new Set(unbound);
  return new Map(
    [...v1ToolPaths(document)].filter(([, tool]) => wanted === undefined || wanted.has(tool)),
  );
};

// ---------------------------------------------------------------------------------------------
// Integrations.

/** The v1 reads source generation needs. */
export type GenerationSource<E> = Pick<
  V1Reader<E>,
  "tools" | "openApiOperations" | "openApiBinding" | "blob" | "blobMissing" | "specification"
>;

/**
 * How the generated provider checks accounts, as the audit counts it: v1's check carried over, the
 * MCP server's own, none because v1 declared none or the app takes no account, or why v1's check
 * is not carried over.
 */
export type HealthOutcome =
  | { readonly kind: "request"; readonly identity: boolean }
  | { readonly kind: "graphql" }
  | { readonly kind: "mcp"; readonly declared: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "dropped"; readonly reason: string };

/** A v1 tool an imported app leaves out because v1 could not run it either (decision 21). */
export interface StaleTool {
  readonly tool: string;
  readonly stale: V1StaleCategory;
  readonly reason: string;
}

/**
 * An integration's generated app: its files, what the user should know, its check, the v1 tools
 * of TRACE operations it leaves out (decision 16), the v1 tools it leaves out as stale (decision
 * 21), and the fixed credentials it leaves out (decision 22). `split` says its connections' rules
 * differ, so each connection moves as its own app instead (decision 33); `rules` counts its own.
 */
export interface GeneratedApp {
  readonly files: SourceFiles;
  readonly note: string | undefined;
  readonly health: HealthOutcome;
  readonly traced: readonly string[];
  readonly stale: readonly StaleTool[];
  readonly dropped: readonly DroppedFixed[];
  readonly split: boolean;
  readonly rules: RuleCounts;
}

const healthOf = (check: GeneratedHealthCheck | undefined) =>
  check === undefined ? {} : { health: check };

/** Why an app with a fixed account has no account check. */
const fixedHealthDropped =
  "Its fixed credentials are held by a second account, which an account check cannot send.";

/** Why a tool v1 last listed before its integration was revised is stale. */
const removedTool =
  "v1 last listed it before the integration was revised, and the revised specification no longer has it, so v1 drops it when it next lists the tools.";

/**
 * The OpenAPI tools v1 last listed before the organization revised the integration, among those
 * v2 would not provide: v1 lists every such connection's tools again on its next read, from the
 * revised specification, which no longer has them. A tool any connection listed since still blocks.
 */
export const removedTools = (
  integration: Pick<IntegrationRow, "config_revised_at">,
  tools: readonly ToolRow[],
  missing: readonly string[],
) => {
  const revised = integration.config_revised_at;
  if (revised === null) return [];
  return missing.filter((name) => {
    const rows = tools.filter((tool) => tool.name === name);
    return rows.length > 0 && rows.every((tool) => (tool.listed_at ?? 0) < revised);
  });
};

const plain = (values: readonly string[]) => (values.length === 1 ? "it is" : "they are");

/** What the user should know about the tools and fixed credentials an app leaves out. */
const leftOutNote = (app: Pick<GeneratedApp, "traced" | "stale" | "dropped">) => {
  const notes: string[] = [];
  if (app.traced.length > 0)
    notes.push(
      `v2 sends no TRACE requests, so ${app.traced.length === 1 ? "its TRACE tool is" : "its TRACE tools are"} left out: ${app.traced.join(", ")}.`,
    );
  if (app.stale.length > 0)
    notes.push(
      `v1 could not run ${app.stale.length === 1 ? "one of its tools" : `${app.stale.length} of its tools`} either, so ${plain(app.stale.map((tool) => tool.tool))} left out: ${app.stale.map((tool) => tool.tool).join(", ")}.`,
    );
  if (app.dropped.length > 0)
    notes.push(
      `Its fixed ${app.dropped.map((entry) => `${entry.secret.carrier} ${entry.secret.name}`).join(", ")} repeated its OAuth client's own credentials, so ${plain(app.dropped.map((entry) => entry.secret.name))} not sent.`,
    );
  return notes.length === 0 ? undefined : notes.join(" ");
};

/**
 * The document v1 stored for an OpenAPI integration, read as v1 read it: a Microsoft Graph preset's
 * entry by entry from its text, as v1 compiled it, and any other whole.
 */
const storedDocument = <E>(
  source: GenerationSource<E>,
  decoded: Extract<ImportableIntegration, { readonly plugin: "openapi" }>,
  bytes: Uint8Array,
) =>
  Effect.gen(function* () {
    if (decoded.config.specFormat === microsoftGraphFormat) {
      const read = blockYamlDocument(bytes);
      if (!read.ok) return yield* fail(read.reason);
      return read;
    }
    const read = parseSpec(bytes);
    if (read.ok === false) return yield* failStale("unreadable_spec", read.reason);
    // v1 stored some specifications as their URL and fetched the document once; so does this.
    // v1 kept what it fetched, so a document that cannot be fetched or read now still blocks.
    const parsed =
      read.ok === "url"
        ? parseSpec(
            yield* source
              .specification(read.url)
              .pipe(Effect.catchTag("SpecificationUnavailable", (error) => fail(error.reason))),
          )
        : read;
    if (parsed.ok === "url")
      return yield* fail("v1's stored specification is a URL whose document is another URL.");
    if (!parsed.ok) return yield* fail(parsed.reason);
    return {
      document: parsedDocument(parsed.document),
      unread: (): string | undefined => undefined,
    };
  });

/**
 * The integration's stored document cut to v1's operations, with v1's operation rows and tool
 * listing. The stored bytes and the document read from them end with this, before the app is
 * generated from the cut.
 */
const importedSpecification = <E>(
  context: { readonly snapshot: V1Rows; readonly source: GenerationSource<E> },
  integration: IntegrationRow,
  decoded: Extract<ImportableIntegration, { readonly plugin: "openapi" }>,
) =>
  Effect.gen(function* () {
    const { tenant, subjects } = context.snapshot;
    const stored = yield* context.source.blob(tenant, "openapi", `spec/${decoded.specHash}`);
    if (Option.isNone(stored)) return yield* fail(context.source.blobMissing);
    const { document, unread } = yield* storedDocument(context.source, decoded, stored.value);
    const operations = yield* context.source.openApiOperations(tenant, integration.slug);
    const tools = yield* context.source.tools(tenant, subjects, integration.slug);
    const compiled = importedDocument(
      document,
      operations,
      compiledTools(document, operations, tools),
    );
    // An entry the cut read could not be parsed: v1 could not read it either.
    const reason = unread();
    if (reason !== undefined) return yield* failStale("unreadable_spec", reason);
    return { compiled, operations, tools };
  });

/** An integration's app source, generated from v1's rows without writing anything. */
export const generate = <E>(
  context: {
    readonly snapshot: V1Rows;
    readonly source: GenerationSource<E>;
    /**
     * False to generate the app as the importer did before it decided tools v1 did not list
     * (`v1ToolRules`), for the repair of organizations moved before then.
     */
    readonly unlistedRules?: boolean;
    /**
     * The connection whose own app this is (decision 33), with the snapshot narrowed to it
     * (`connectionSnapshot`): its rules are v1's for that connection alone.
     */
    readonly connection?: ConnectionRow;
  },
  integration: IntegrationRow,
  decoded: ImportableIntegration,
  planned: Pick<AppAccounts, "methods" | "shared" | "fixed" | "dropped" | "plans">,
) =>
  Effect.gen(function* () {
    const { methods, shared: sharedAccounts, dropped } = planned;
    const fixedAccount = planned.fixed?.account;
    const name = integrationLabel(integration);
    const { tenant, subjects } = context.snapshot;
    const accounts = Object.keys(methods).length > 0;
    // Credentials in v1's configuration are account fields; only the rest is written to source.
    const { headers, queryParams } = integrationValues(decoded);
    const accountOptions = {
      sharedAccounts,
      ...(fixedAccount === undefined ? {} : { fixedAccount }),
    };
    const left = { traced: [], stale: [], dropped } as const;
    // The app's rules, and for the whole integration whether its connections' rules differ.
    const toolRules = (
      tools: readonly ToolRow[],
      aliases?: Readonly<Record<string, string>>,
      exposed?: readonly string[],
    ) => {
      const rules =
        context.unlistedRules === false
          ? approvalRules(toolActions(context.snapshot, integration, tools, aliases))
          : v1ToolRules(context.snapshot, integration, tools, aliases, exposed, context.connection);
      const split =
        context.connection === undefined &&
        context.unlistedRules !== false &&
        rulesDiffer(
          context.snapshot,
          integration,
          tools,
          planned.plans.map((plan) => plan.row),
          aliases,
          exposed,
        );
      return { rules, split, counts: ruleCounts(rules) };
    };
    // An MCP server's rules, named as v1 listed its tools, and what to tell the person about them.
    const mcpRules = Effect.gen(function* () {
      const tools = yield* context.source.tools(tenant, subjects, integration.slug);
      const { rename, overrides, aliases, missing } = mcpNaming(tools);
      if (missing.length > 0) return yield* fail(missingNames(missing));
      const decided = toolRules(tools, aliases);
      const rules: GeneratedToolRules = {
        ...(rename ? { names: { kind: "lower_snake", overrides } } : {}),
        ...decided.rules,
      };
      const aliased = Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1));
      const notes = [
        ...(aliased.length === 0
          ? []
          : [
              `v1 listed ${aliased.length === 1 ? "a tool" : "tools"} under two names; ${aliased
                .map(([alias, kept]) => `${alias} is now ${kept}`)
                .join(", ")}.`,
            ]),
        ...(leftOutNote(left) === undefined ? [] : [leftOutNote(left)]),
      ];
      return { rules, decided, note: notes.length === 0 ? undefined : notes.join(" ") };
    });
    switch (decoded.plugin) {
      case "stdio": {
        // The product runs the command and keeps it; the app holds only v1's rules for its tools.
        const { rules, decided, note } = yield* mcpRules;
        return {
          files: yield* decoded.source({ name, tenant, integration: integration.row_id }, rules),
          note,
          health: { kind: "none" as const },
          ...left,
          split: decided.split,
          rules: decided.counts,
        } satisfies GeneratedApp;
      }
      case "mcp": {
        const { rules, decided, note } = yield* mcpRules;
        const generated = yield* generateMcpSource(
          name,
          decoded.config.endpoint,
          { kind: "methods", methods },
          { headers, queryParams, tools: rules, ...accountOptions },
        );
        return {
          files: generated.files,
          note,
          // v1's MCP check only listed tools, whatever it declared, as mcpHealth does.
          health: !accounts
            ? { kind: "none" as const }
            : fixedAccount !== undefined
              ? { kind: "dropped" as const, reason: fixedHealthDropped }
              : { kind: "mcp" as const, declared: integration.health_check !== null },
          ...left,
          split: decided.split,
          rules: decided.counts,
        } satisfies GeneratedApp;
      }
      case "graphql": {
        const tools = yield* context.source.tools(tenant, subjects, integration.slug);
        const missing = graphqlMissing(tools);
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const decided = toolRules(tools);
        const check: GeneratedHealthCheck | undefined =
          accounts && decoded.healthCheck && fixedAccount === undefined
            ? { kind: "graphql", query: v1IntrospectionQuery }
            : undefined;
        const generated = yield* graphqlAppSource({
          name,
          url: decoded.config.endpoint,
          methods,
          ...accountOptions,
          headers,
          queryParams,
          tools: {
            names: { kind: "graphql_path" },
            ...decided.rules,
          },
          ...healthOf(check),
        });
        return {
          files: generated.files,
          note: leftOutNote(left),
          health:
            check !== undefined
              ? { kind: "graphql" as const }
              : accounts && decoded.healthCheck && fixedAccount !== undefined
                ? { kind: "dropped" as const, reason: fixedHealthDropped }
                : { kind: "none" as const },
          ...left,
          split: decided.split,
          rules: decided.counts,
        } satisfies GeneratedApp;
      }
      case "openapi": {
        const { compiled, operations, tools } = yield* importedSpecification(
          context,
          integration,
          decoded,
        );
        // v1 sent each operation to its own server unless the integration set a base URL, with the
        // account's credentials on every one, and the app does the same. An operation v1 never
        // reached, on a server that is not http(s) or uses an undefined variable, is left out.
        const servers = operationBaseUrls(decoded.config, compiled.document);
        if (!servers.ok) return yield* refused(servers);
        const reachable = withoutOperations(compiled, servers.unreachable);
        const prepared = { ...compiled, document: reachable.document, named: reachable.named };
        const unreachable = reachable.removed.flatMap(({ key, tool }): StaleTool[] => {
          const operation = servers.unreachable.find(
            (candidate) => `${candidate.method} ${candidate.path}` === key,
          );
          return operation === undefined
            ? []
            : [{ tool, stale: operation.stale, reason: operation.reason }];
        });
        // The account's credentials go to every origin its operations call, as in v1; the
        // provider's hosts keep them to exactly those.
        const origins = credentialOrigins(servers.urls);
        // v1 also sent the credentials over plain HTTP when a server named it; an app that sends
        // them to several hosts does so only over HTTPS.
        const insecure = accounts && origins.length > 1 ? plainHttpHosts(origins) : [];
        if (insecure.length > 0)
          return yield* fail(
            `Its operations call ${insecure.join(", ")} over plain HTTP, and an imported app sends an account's credentials to more than one host only over HTTPS.`,
          );
        // The name liveOpenapiRouter gives each operation, as it reads the document, mapped to v1's.
        const declared = yield* Effect.tryPromise({
          try: () => openapiOperationNames(prepared.document),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof OpenapiCompileError ? fail(error.reason) : Effect.die(error),
          ),
        );
        const names: Record<string, string> = {};
        for (const operation of declared) {
          const v1 = prepared.named.get(`${operation.method.toLowerCase()} ${operation.path}`);
          if (v1 !== undefined) names[operation.name] = v1;
        }
        const exposed = new Set(Object.values(names));
        // Every tool v1 bound or last listed, except those of the TRACE operations it drops and
        // of the operations v1 never reached.
        const leftOut = new Set([...prepared.traced, ...unreachable.map((tool) => tool.tool)]);
        const missing = [
          ...new Set([...operations.map((operation) => operation.tool), ...toolNames(tools)]),
        ].filter((tool) => !exposed.has(tool) && !leftOut.has(tool));
        const removed = new Set(removedTools(integration, tools, missing));
        const blocking = missing.filter((tool) => !removed.has(tool));
        if (blocking.length > 0) return yield* fail(missingNames(blocking));
        const stale: readonly StaleTool[] = [
          ...unreachable,
          ...[...removed]
            .sort()
            .map((tool) => ({ tool, stale: "removed_tool" as const, reason: removedTool })),
        ];
        const staleNames = new Set(stale.map((tool) => tool.tool));
        const spec = decoded.healthCheck;
        const checked =
          !accounts || spec === undefined
            ? undefined
            : fixedAccount !== undefined
              ? ({ ok: false, reason: fixedHealthDropped } as const)
              : openapiHealth({
                  config: decoded.config,
                  spec,
                  binding: yield* context.source.openApiBinding(
                    tenant,
                    integration.slug,
                    spec.operation,
                  ),
                  origins,
                });
        const decided = toolRules(
          tools.filter((tool) => !staleNames.has(tool.name)),
          {},
          [...exposed].filter((name) => !staleNames.has(name)),
        );
        const generated = yield* openapiAppSource({
          name,
          document: prepared.document,
          baseUrl: decoded.config.baseUrl,
          allowedOrigins: origins,
          methods,
          ...accountOptions,
          headers,
          queryParams,
          tools: { names: { kind: "map", names }, ...decided.rules },
          ...healthOf(checked?.ok === true ? checked.check : undefined),
        });
        const outcome = { traced: prepared.traced, stale, dropped };
        return {
          files: generated.files,
          note: leftOutNote(outcome),
          ...outcome,
          health:
            checked === undefined
              ? { kind: "none" as const }
              : checked.ok
                ? {
                    kind: "request" as const,
                    identity:
                      checked.check.kind === "request" && checked.check.identity !== undefined,
                  }
                : { kind: "dropped" as const, reason: checked.reason },
          split: decided.split,
          rules: decided.counts,
        } satisfies GeneratedApp;
      }
    }
  }).pipe(
    Effect.catchIf(
      (error): error is TemplateError => error instanceof TemplateError,
      (error) => fail(error.reason),
    ),
  );

/** The app's fixed account's field names and values, from v1's configuration (decision 22). */
export const fixedAccount = (planned: AppAccounts) =>
  planned.fixed === undefined
    ? fail("Its imported app takes fixed credentials its integration no longer has.")
    : Effect.succeed({
        names: planned.fixed.account.fields,
        values: Redacted.make(Object.fromEntries(planned.fixed.configured)),
      });

// ---------------------------------------------------------------------------------------------
// Connections.

/** Why a copied sign-in was refused for no reason the person can act on but signing in again. */
const notCarriedOver = (wording: Pick<V1ImportProduct["wording"], "destination" | "reconnect">) =>
  `Its sign-in could not be carried over to ${wording.destination}. ${wording.reconnect}`;

/**
 * Why a copied sign-in could not be set up, in the words of what to do next. An outage clears up
 * by itself; the rest need a new sign-in.
 */
const oauthSetupReason = (
  wording: V1ImportProduct["wording"],
  reason: OAuthSetupFailed["reason"],
) =>
  reason === "service_unavailable" || reason === "rate_limited"
    ? `The service did not respond while its sign-in was set up. ${wording.outage}`
    : reason === "discovery_missing" ||
        reason === "discovery_invalid" ||
        reason === "discovery_blocked"
      ? `The service no longer says how to sign in to it. ${wording.reconnect}`
      : notCarriedOver(wording);

/** What reading a saved credential needs: the product's wording, the subjects and the store. */
type SecretContext<E> = {
  readonly product: Pick<V1ImportProduct, "wording">;
  readonly source: Pick<V1Reader<E>, "secret">;
  readonly snapshot: Pick<V1Rows, "tenant" | "subjects">;
};

/**
 * A connection's or client's secret from v1's credential store, read as v1 read it: an org item in
 * the organization's partition, a user-scoped item in the partition of the member who saved it
 * (see {@link secretSubjects}). One that no partition holds is stale: v1 cannot send it either.
 */
export const readSecret = <E>(
  context: SecretContext<E>,
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
) => readSecretOf(context, row, itemId, false).pipe(Effect.map(({ value }) => value));

/**
 * A connection's secret as `readSecret` reads it, and, for an org connection whose user-scoped item
 * several members hold, how many hold it and how many distinct values they hold (decision 23).
 * The first member's value is the one that moves; the others are only compared, in memory.
 */
export const readSecretCompared = <E>(
  context: SecretContext<E>,
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
) => readSecretOf(context, row, itemId, true);

const readSecretOf = <E>(
  context: SecretContext<E>,
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
  compare: boolean,
) =>
  Effect.gen(function* () {
    // The first subject whose partition holds the item, as v1 found it for that caller.
    let first: string | undefined;
    const values = new Set<string>();
    let holders = 0;
    for (const subject of secretSubjects(context.snapshot, row, itemId)) {
      const value = yield* context.source
        .secret({ tenant: context.snapshot.tenant, subject, itemId })
        .pipe(
          Effect.catchTag("V1CredentialsUnavailable", () =>
            Effect.fail(
              new ItemFailed({
                reason: "v1's credential store did not answer while its saved credential was read.",
                credential: "unavailable",
              }),
            ),
          ),
        );
      if (value === undefined || value === "") continue;
      first ??= value;
      holders += 1;
      values.add(value);
      if (!compare) break;
    }
    if (first === undefined)
      return yield* new ItemFailed({
        reason: `Its saved credential could not be found in v1. ${context.product.wording.reconnect}`,
        credential: "missing",
        stale: "missing_credential",
      });
    return { value: Redacted.make(first), holders, values: values.size };
  });

/**
 * The subjects whose credential partition may hold a connection's item. v1 reads an item with the
 * calling member's binding, and a user-scoped item (`connection:user:…`) lives under the subject
 * that saved it. A member's own connection is read as them. An org connection has no subject
 * (`''`), and one that holds a user-scoped item, saved before it was shared, resolved in v1 for
 * the member who saved it, so each imported member is tried in turn. Org-scoped and legacy items
 * do not depend on the subject.
 */
const secretSubjects = (
  snapshot: Pick<V1Rows, "subjects">,
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
): readonly string[] =>
  row.owner === "org" && itemOwner(itemId) === "user" ? snapshot.subjects : [row.subject];

/** The account's name; an org connection yields its name to a personal one. */
export const accountLabel = (snapshot: Pick<V1Rows, "connections">, row: ConnectionRow) =>
  row.owner === "org" &&
  snapshot.connections.some(
    (other) =>
      other.owner === "user" && other.integration === row.integration && other.name === row.name,
  )
    ? `${row.name} (workspace)`
    : row.name;

/**
 * The account requirements a generated app declares, as the app templates spell them
 * (`accountScopes` in `@executor-js/app-templates`): each person's own accounts, the accounts
 * linked for everyone (`sharedAccounts`), and the one account holding fixed credentials
 * (`fixedAccount`), whose name is also its sign-in method's.
 */
export const personalRequirement = "service";
export const sharedRequirement = "workspace";
export const fixedRequirement = "fixed";

/**
 * The requirement a connection's account is linked to: everyone's for an org connection where the
 * product shares those (decision 9), the person's own otherwise. `appAccounts` declares the shared
 * requirement exactly when one of its connections is linked to it.
 */
export const accountRequirement = (
  product: Pick<V1ImportProduct, "orgAccounts">,
  row: Pick<ConnectionRow, "owner">,
) =>
  product.orgAccounts === "shared" && row.owner === "org" ? sharedRequirement : personalRequirement;

/** The accounts an integration's app takes, by requirement: a deployed app's or a build's. */
export type AppAccountRequirements = DeployedApp["requirements"]["accounts"];

/**
 * The account a connection's import saves, decided from v1's rows and secrets and the app's
 * requirements, writing nothing: the requirement it fills and the grant or fields it holds, or
 * why it cannot be saved. An import saves it and a dry run checks it, so a dry run refuses every
 * account an import would, with the same reason.
 */
export type AccountWrite =
  | {
      readonly kind: "grant";
      readonly requirement: AccountRequirement;
      readonly input: ImportOAuthGrant;
      /** The operator's client a first-party grant moves to, which its refusal names. */
      readonly firstParty?: {
        readonly name: string;
        readonly client: { readonly placement: { readonly hosts: readonly string[] } };
        readonly hosts: readonly string[];
      };
    }
  | {
      readonly kind: "fields";
      readonly requirement: AccountRequirement;
      readonly input: {
        readonly owner: OwnerId;
        readonly provider: AccountRequirement["provider"];
        readonly method: string;
        readonly label: string;
        readonly fields: Redacted.Redacted<Record<string, string>>;
      };
    };

/** Reads one of a connection's secrets from v1's credential store, as `readSecret` does. */
export type SecretReader<E> = (
  itemId: string,
) => Effect.Effect<Redacted.Redacted<string>, ItemFailed | E>;

/**
 * Whether a connection's account goes to its own app (decision 33), whose sign-in methods are its
 * alone, or to its integration's one app.
 */
export type AppScope = "own" | "integration";

/**
 * The sign-in method a connection's account is saved under: its method in the app it goes to, as
 * `appAccounts` plans that app from the same rows, so the two cannot disagree. Undefined when the
 * app has none for it.
 */
export const accountMethod = <E>(
  context: AccountContext<E>,
  plan: Pick<ConnectionPlan, "row" | "integration">,
  scope: AppScope,
) =>
  Effect.gen(function* () {
    const scoped = scope === "own" ? connectionContext(context, plan.row) : context;
    const planned = yield* appAccounts(scoped, plan.integration);
    return {
      method: planned.methodOf.get(plan.row.row_id),
      configured: planned.configured.get(plan.row.row_id) ?? [],
    };
  });

export const accountWrite = <E>(input: {
  readonly context: AccountContext<E>;
  readonly plan: ConnectionPlan;
  /** The requirements of the app the account goes to. */
  readonly accounts: AppAccountRequirements;
  readonly owner: OwnerId;
  readonly secret: SecretReader<E>;
  readonly scope: AppScope;
}) =>
  Effect.gen(function* () {
    const { context, plan, owner, secret } = input;
    const requirement = input.accounts[accountRequirement(context.product, plan.row)];
    if (requirement === undefined) return yield* fail("Its imported app takes no account.");
    const planned = yield* accountMethod(context, plan, input.scope);
    if (planned.method === undefined)
      return yield* fail("Its sign-in method is not in the imported app.");
    const base = {
      owner,
      provider: requirement.provider,
      method: planned.method,
      label: accountLabel(context.snapshot, plan.row),
    };
    const callback = context.product.callback;
    const expiresAt = plan.row.expires_at === null ? {} : { expiresAt: plan.row.expires_at };
    const access = plan.access;
    if (access.kind === "first_party") {
      const accessToken = yield* secret(access.accessItem);
      const refreshToken =
        plan.row.refresh_item_id === null ? undefined : yield* secret(plan.row.refresh_item_id);
      const hosts = requirement.definition.hosts ?? [];
      return {
        kind: "grant",
        requirement,
        input: {
          ...base,
          redirectUri: callback,
          firstParty: access.client.id,
          hosts,
          accessToken,
          refreshToken,
          ...expiresAt,
          renewal: access.renewal,
        },
        firstParty: { name: firstPartyName(access.client.id), client: access.client, hosts },
      } satisfies AccountWrite as AccountWrite;
    }
    if (access.kind !== "oauth") {
      // Values from v1's configuration first, then the connection's own from its credential store.
      const fields: Record<string, string> = Object.fromEntries(planned.configured);
      if (access.kind === "secrets")
        for (const [variable, item] of access.items)
          fields[variable] = Redacted.value(yield* secret(item));
      return {
        kind: "fields",
        requirement,
        input: { ...base, fields: Redacted.make(fields) },
      } satisfies AccountWrite as AccountWrite;
    }
    const { client, grant } = access;
    const clientSecret =
      client.client_secret_item_id === null
        ? undefined
        : yield* secret(client.client_secret_item_id);
    const registration = yield* Schema.decodeUnknownEffect(OAuthRegistration)({
      client_id: client.client_id,
      token_endpoint_auth_method:
        clientSecret === undefined
          ? "none"
          : (tokenEndpointAuthMethod(client.token_endpoint_auth_method) ?? "client_secret_post"),
      ...(clientSecret === undefined ? {} : { client_secret: Redacted.value(clientSecret) }),
    }).pipe(Effect.catch(() => fail("Its OAuth client could not be read.")));
    const accessToken = yield* secret(access.accessItem);
    const refreshToken =
      grant === "authorization_code" && plan.row.refresh_item_id !== null
        ? yield* secret(plan.row.refresh_item_id)
        : undefined;
    return {
      kind: "grant",
      requirement,
      input: {
        ...base,
        ...(grant === "authorization_code"
          ? { redirectUri: client.origin_redirect_uri ?? callback }
          : {}),
        client: Redacted.make(registration),
        accessToken,
        refreshToken,
        ...expiresAt,
        renewal: access.renewal,
      },
    } satisfies AccountWrite as AccountWrite;
  });

/** What v2 refuses a copied grant with, which `grantRefusals` words for the person. */
type GrantRefusal = OAuthSetupFailed | AuthMethodInvalid | OAuthGrantNotImportable;

const isGrantRefusal = (error: unknown): error is GrantRefusal =>
  Predicate.isTagged(error, "OAuthSetupFailed") ||
  Predicate.isTagged(error, "AuthMethodInvalid") ||
  Predicate.isTagged(error, "OAuthGrantNotImportable");

/** A refused grant as the item's refusal. An outage is marked, as trying again may succeed. */
const grantRefusal = (
  product: Pick<V1ImportProduct, "wording">,
  write: Extract<AccountWrite, { kind: "grant" }>,
  error: GrantRefusal,
) => {
  switch (error._tag) {
    case "OAuthSetupFailed":
      return new ItemFailed({
        reason: oauthSetupReason(product.wording, error.reason),
        ...(error.reason === "service_unavailable" || error.reason === "rate_limited"
          ? { outage: true as const }
          : {}),
      });
    case "AuthMethodInvalid":
      return new ItemFailed({ reason: "Its sign-in method is not in the imported app." });
    case "OAuthGrantNotImportable": {
      if (write.firstParty === undefined)
        return new ItemFailed({ reason: notCarriedOver(product.wording) });
      const { name, client, hosts } = write.firstParty;
      const unreachable = error.unreachable ?? [];
      return new ItemFailed({
        reason: firstPartyRefusal(
          product.wording,
          name,
          error.reason === "unavailable"
            ? { kind: "unavailable" }
            : error.reason === "scopes"
              ? { kind: "granted_scopes" }
              : error.reason === "hosts"
                ? {
                    kind: "hosts",
                    sendsTo: client.placement.hosts,
                    unreachable:
                      unreachable.length === 0 || unreachable.length === hosts.length
                        ? "all"
                        : unreachable,
                  }
                : { kind: "resource" },
        ),
      });
    }
  }
};

/** Why v2 refused to save a connection's grant, as the user reads it, for an import and a check. */
export const grantRefusals =
  (product: Pick<V1ImportProduct, "wording">, write: Extract<AccountWrite, { kind: "grant" }>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | ItemFailed, R> =>
    Effect.mapError(self, (error) =>
      isGrantRefusal(error) ? grantRefusal(product, write, error) : error,
    );

/**
 * The tokens an account copied from a connection takes when v1 renewed the connection's grant
 * after the copy: v1's current access and refresh tokens. A service that rotates refresh tokens
 * keeps only the last renewal's, so the product hands them to `refreshImportedGrant`, which keeps
 * the account's own when they are newer. Undefined for a connection without an authorization-code
 * grant and a refresh token, or whose tokens v1's store no longer holds: its account is left as it
 * is. A store that does not answer fails with `ItemFailed`.
 */
export const copiedGrantTokens = <E>(context: SecretContext<E>, plan: ConnectionPlan) =>
  Effect.gen(function* () {
    const { access, row } = plan;
    const accessItem =
      access.kind === "first_party" ||
      (access.kind === "oauth" && access.grant === "authorization_code")
        ? access.accessItem
        : undefined;
    if (accessItem === undefined || row.refresh_item_id === null) return undefined;
    return {
      accessToken: yield* readSecret(context, row, accessItem),
      refreshToken: yield* readSecret(context, row, row.refresh_item_id),
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    };
  }).pipe(
    Effect.catchIf(
      (error) => error instanceof ItemFailed && error.credential === "missing",
      () => Effect.succeed(undefined),
    ),
  );

/** Whether a connection's app is public: it takes no account, so the connection needs none. */
export const needsNoAccount = (plan: ConnectionPlan, accounts: AppAccountRequirements) =>
  plan.access.kind === "none" &&
  accounts[personalRequirement] === undefined &&
  accounts[sharedRequirement] === undefined;
