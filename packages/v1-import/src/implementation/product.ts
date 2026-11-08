/**
 * What an importing product knows that v1's rows do not say. Each product states these facts once
 * and every decision reads them from here, so an app's sign-in methods and the accounts saved for
 * them are decided from the same facts.
 */
import type { GeneratedToolRules, TemplateError } from "@executor-js/app-templates";
import type { FirstPartyOAuthClientDescription, SourceFiles } from "@executor-js/sdk/core";
import type { Effect } from "effect";

/**
 * The operator's OAuth client v2 offers under one of v1's first-party names (`google` for
 * `first-party:google`), or undefined when it offers none: the client's credentials are not set.
 */
export type FirstPartyClients = (name: string) => FirstPartyOAuthClientDescription | undefined;

export interface V1ImportProduct {
  /**
   * The `connection.provider` whose saved credentials this product's import reads: v1 Cloud's
   * `workos-vault`, a local v1's `file`. A connection kept in any other store has none to copy.
   */
  readonly credentialProvider: string;
  /** The OAuth clients v1's first-party connections move to. */
  readonly firstParty: FirstPartyClients;
  /** Where v1 sent sign-ins when an OAuth client recorded none: its own callback. */
  readonly callback: string;
  /**
   * Who a v1 workspace (org) connection's account is for. `shared`: everyone, linked to the app's
   * `workspace` requirement (decision 9). `personal`: the one person who imports, linked to their
   * own `service` requirement, so the app declares no `workspace` requirement at all.
   */
  readonly orgAccounts: "shared" | "personal";
  /**
   * Whether an app none of whose connections moved declares the sign-in methods its integration
   * declared, so its people can connect accounts to it afterwards.
   */
  readonly declaredMethods: boolean;
  /**
   * Whether the product runs a v1 local (stdio) MCP server's command, as v1 did. One that does
   * generates the server's app with `source`, given the app's name and v1's tool rules; the command
   * stays with the product, never in the source. One that does not refuses every local server
   * with `refusal`.
   */
  readonly localServers:
    | { readonly runs: false; readonly refusal: string }
    | {
        readonly runs: true;
        readonly source: (
          name: string,
          rules: GeneratedToolRules,
        ) => Effect.Effect<SourceFiles, TemplateError>;
      };
  /** The product's words for what a person does next. */
  readonly wording: {
    /**
     * The product as its people name it, inside a sentence: "Executor v2", or "this Executor" for
     * a product whose people know no other version.
     */
    readonly product: string;
    /** Where an import moves things, inside a sentence: "v2", or "this Executor". */
    readonly destination: string;
    /** One of the product's sign-in methods, inside a sentence: "an Executor v2 sign-in method". */
    readonly signInMethod: string;
    /** Ends a refusal the person fixes by signing in again, such as "Reconnect it in v2." */
    readonly reconnect: string;
    /** Ends a refusal from a service that did not respond, which a later attempt may not hit. */
    readonly outage: string;
    /** Why no app was made: every name the importer tries (`appNames`) is taken. */
    readonly namesTaken: string;
  };
}
