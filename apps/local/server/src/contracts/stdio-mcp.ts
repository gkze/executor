/**
 * Stdio MCP servers the local server runs for apps. Apps cannot start processes, so the server
 * starts the command and serves it over Streamable HTTP; see `implementation/stdio-mcp.ts`.
 */
import {
  AccountFieldsInvalid,
  AccountId,
  AccountNotFound,
  AccountSelectionInvalid,
  AppName,
  AppNameTaken,
  AppNotFound,
  AppSlugTaken,
  AppVersionChanged,
  AuthMethodInvalid,
  BuildMemoryExceeded,
  CredentialsError,
  DeployedApp,
  MarkdownUnavailable,
  ProviderNotFound,
  RequestRejection,
  SkillDefinitionInvalid,
  StorageError,
  VersionBuildFailed,
  sourceErrors,
} from "@executor-js/sdk";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

/** The ID in a stdio server's bridge path, `/stdio-mcp/<id>`. */
export const StdioMcpServerId = Schema.String.check(Schema.isPattern(/^stdio_[0-9a-f]{32}$/u)).pipe(
  Schema.brand("StdioMcpServerId"),
);
export type StdioMcpServerId = typeof StdioMcpServerId.Type;

/** A portable environment variable name. */
export const EnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u));

/**
 * The account field that holds the bridge token. Secret variables become fields of the same
 * account, so none may take this name.
 */
export const bridgeTokenField = "token";

/**
 * A secret value: printable ASCII without leading or trailing spaces. It travels as an HTTP header
 * value, which cannot carry other characters and loses surrounding spaces.
 */
const SecretValue = Schema.String.check(
  Schema.isPattern(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u),
);

/** An absolute path on POSIX or Windows. */
const AbsolutePath = Schema.String.check(
  Schema.makeFilter((value) => /^(\/|[A-Za-z]:[\\/]|\\\\)/u.test(value), {
    expected: "an absolute path",
  }),
);

/**
 * A secret variable travels in a header named after it, and header names ignore case, so secret
 * names must differ from each other, and from plain variables, ignoring case.
 */
const distinctNames = (input: {
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly secrets?: Readonly<Record<string, unknown>> | undefined;
}) => {
  const secrets = Object.keys(input.secrets ?? {}).map((name) => name.toLowerCase());
  const plain = new Set(Object.keys(input.env ?? {}).map((name) => name.toLowerCase()));
  return (
    new Set(secrets).size === secrets.length &&
    !secrets.some((name) => plain.has(name)) &&
    !Object.hasOwn(input.secrets ?? {}, bridgeTokenField)
  );
};

/**
 * A server to run: the command and its arguments, run without a shell; an absolute working
 * directory; plain variables kept with the server; and secret variables, which are saved only in
 * the app's account and sent to the bridge with each new session.
 */
export const StdioMcpServerInput = Schema.Struct({
  name: AppName,
  command: Schema.NonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(AbsolutePath),
  env: Schema.optional(Schema.Record(EnvName, Schema.String)),
  secrets: Schema.optional(Schema.Record(EnvName, Schema.RedactedFromValue(SecretValue))),
}).check(
  Schema.makeFilter(distinctNames, {
    expected: `secret names distinct from each other and from plain variable names ignoring case, and none named "${bridgeTokenField}"`,
  }),
);
export type StdioMcpServerInput = typeof StdioMcpServerInput.Type;

/** The deployed app and the account, linked to it, that holds its bridge token and secrets. */
export const StdioMcpServerCreated = Schema.Struct({ app: DeployedApp, account: AccountId });

const localStdioMcpApi = HttpApi.make("local-stdio-mcp").add(
  HttpApiGroup.make("stdioMcpServers").add(
    HttpApiEndpoint.post("create", "/v1/stdio-mcp-servers", {
      payload: StdioMcpServerInput,
      success: StdioMcpServerCreated,
      error: [
        StorageError,
        ...sourceErrors,
        VersionBuildFailed,
        BuildMemoryExceeded,
        MarkdownUnavailable,
        SkillDefinitionInvalid,
        AppNameTaken,
        AppSlugTaken,
        AppNotFound,
        AppVersionChanged,
        AccountNotFound,
        AccountSelectionInvalid,
        CredentialsError,
        ProviderNotFound,
        AuthMethodInvalid,
        AccountFieldsInvalid,
      ],
    })
      .annotate(OpenApi.Summary, "Add a stdio MCP server")
      .annotate(
        OpenApi.Description,
        "Create and deploy an app for a stdio MCP server that this local server starts and serves over HTTP. The command runs on this machine as the user running Executor, without a shell. Secret variables are saved only in the account linked to the app.",
      ),
  ),
);
/** Every endpoint answers a request its schema rejects with `RequestInvalid`. */
export const LocalStdioMcpApi = localStdioMcpApi.middleware(RequestRejection);
