/**
 * `executor import-v1`. With `--dry-run` it decides every item in this process, reading Executor
 * 1's files and writing nothing. Otherwise it reads which integrations each workspace has, has the
 * background Executor import them a few at a time, printing progress on stderr, and reports what
 * the background Executor answered for each item. A batch that fails stops the import: the report
 * shows what moved before it, then the command fails with the reason.
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Console, Effect, Option, type Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  LocalV1ImportApi,
  type V1ImportItem,
  type V1ImportReport,
  V1ImportReport as V1ImportReportSchema,
  type V1ImportWorkspace,
} from "../contracts/v1-import.ts";
import { planV1Import, renderReport, v1Directory } from "./v1-import.ts";

/** Integrations per request: each request builds their apps, well within an HTTP response. */
const batchSize = 4;

const keyOf = (item: Pick<V1ImportItem, "kind" | "id">) => `${item.kind}:${item.id}`;

const print = (report: V1ImportReport, json: boolean) =>
  Console.log(
    json
      ? JSON.stringify(Schema.encodeSync(V1ImportReportSchema)(report), null, 2)
      : renderReport(report),
  );

/** A tool policy across batches: moved if any batch's apps took it, else the first answer. */
const combine = (answers: readonly V1ImportItem[]) =>
  answers.find((answer) => answer.outcome === "moves") ??
  answers.find((answer) => answer.outcome === "failed") ??
  answers[0];

/**
 * A workspace's report from the background Executor's answers. An item the rows plan says moves is
 * reported only as an answer says: one no answer covers did not move, because the import stopped
 * first (`stopped`) or Executor 1 no longer has what it belonged to.
 */
const answered = (
  planned: readonly V1ImportItem[],
  answers: readonly V1ImportItem[],
  stopped: boolean,
): readonly V1ImportItem[] => {
  const byKey = new Map<string, V1ImportItem[]>();
  for (const answer of answers)
    byKey.set(keyOf(answer), [...(byKey.get(keyOf(answer)) ?? []), answer]);
  const unanswered = (item: V1ImportItem): V1ImportItem =>
    item.outcome !== "moves"
      ? item
      : stopped
        ? { ...item, outcome: "failed", reason: "The import stopped before it." }
        : {
            ...item,
            outcome: "skipped",
            reason: "What it belonged to no longer exists in Executor 1.",
          };
  const plannedKeys = new Set(planned.map(keyOf));
  return [
    ...planned.map((item) => {
      const found = byKey.get(keyOf(item));
      return found === undefined ? unanswered(item) : (combine(found) ?? unanswered(item));
    }),
    // Connections Executor 1 gained since the command read it.
    ...answers.filter((answer, index) => {
      const key = keyOf(answer);
      return !plannedKeys.has(key) && answers.findIndex((other) => keyOf(other) === key) === index;
    }),
  ];
};

export const importV1 = <E, R>(
  options: {
    readonly dryRun: boolean;
    readonly from: Option.Option<string>;
    readonly workspace: Option.Option<string>;
    readonly json: boolean;
  },
  server: Effect.Effect<{ readonly url: string; readonly token: Redacted.Redacted<string> }, E, R>,
) =>
  Effect.gen(function* () {
    const from = yield* v1Directory(options.from);
    if (options.dryRun)
      return yield* print(
        {
          from,
          dryRun: true,
          workspaces: yield* planV1Import(from, options.workspace, "dry_run"),
        },
        options.json,
      );
    const plan = yield* planV1Import(from, options.workspace, "rows");
    const target = yield* server;
    const client = yield* HttpApiClient.make(LocalV1ImportApi, {
      baseUrl: target.url,
      transformClient: (http) =>
        http.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(target.token))),
    });
    const workspaces: V1ImportWorkspace[] = [];
    let failure: Option.Option<Effect.Error<ReturnType<typeof client.v1Import.run>>> =
      Option.none();
    // A local (stdio) server's command is found on this shell's PATH, when it has one.
    const path = process.env.PATH;
    for (const workspace of plan) {
      const integrations = workspace.items.filter((item) => item.kind === "integration");
      const answers: V1ImportItem[] = [];
      for (
        let start = 0;
        start < integrations.length && Option.isNone(failure);
        start += batchSize
      ) {
        const batch = integrations.slice(start, start + batchSize);
        yield* Console.error(
          `Importing ${workspace.tenant}: integrations ${start + 1}-${start + batch.length} of ${integrations.length}`,
        );
        const imported = yield* client.v1Import
          .run({
            payload: {
              from,
              workspace: workspace.tenant,
              integrations: batch.map((item) => item.id),
              ...(path === undefined || path === "" ? {} : { path }),
            },
          })
          .pipe(Effect.result);
        if (imported._tag === "Failure") failure = Option.some(imported.failure);
        else answers.push(...imported.success.items);
      }
      workspaces.push({
        tenant: workspace.tenant,
        items: answered(workspace.items, answers, Option.isSome(failure)),
      });
    }
    yield* print({ from, dryRun: false, workspaces }, options.json);
    if (Option.isSome(failure)) return yield* Effect.fail(failure.value);
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
