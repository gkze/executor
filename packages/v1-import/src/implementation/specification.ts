/**
 * The document at a URL v1 stored as an OpenAPI integration's specification. v1 fetched it once,
 * when the integration was added, and kept the URL; an import fetches it the same way.
 */
import { Effect, Stream } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { SpecificationUnavailable } from "../contracts/index.ts";

/** The largest specification the import fetches, as large as an OpenAPI app's router downloads. */
const maxSpecificationBytes = 40_000_000;

/**
 * The document at the URL v1 stored as an integration's specification, fetched once, as v1 fetched
 * it when the integration was added: a GET without the integration's credentials, within 60
 * seconds, of at most `maxSpecificationBytes`. Redirects are followed, as v1 followed them.
 */
export const fetchSpecification = (http: HttpClient.HttpClient, url: string) =>
  Effect.gen(function* () {
    const unavailable = (why: string) =>
      new SpecificationUnavailable({
        reason: `v1 stored its specification as a URL, and ${why}.`,
      });
    const response = yield* http
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader(
            "accept",
            "application/json, application/yaml, text/yaml, */*",
          ),
        ),
      )
      .pipe(Effect.mapError(() => unavailable("fetching it failed")));
    if (response.status < 200 || response.status >= 300)
      return yield* unavailable(`fetching it answered HTTP ${response.status}`);
    const chunks = yield* response.stream.pipe(
      Stream.mapError(() => unavailable("reading its document failed")),
      Stream.limitBytes(maxSpecificationBytes, () =>
        Stream.fail(unavailable(`its document is larger than ${maxSpecificationBytes} bytes`)),
      ),
      Stream.runCollect,
    );
    const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () =>
        Effect.fail(
          new SpecificationUnavailable({
            reason: "v1 stored its specification as a URL, and fetching it took over 60 seconds.",
          }),
        ),
    }),
  );
