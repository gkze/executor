# @executor-js/v1-import

Decodes Executor v1's stored rows and decides what each item becomes in v2. Cloud's server-side
import and the local `executor import-v1` command both decide with it.

It never writes. Each product reads its own v1, Cloud's Postgres or a local v1's SQLite file, into
`V1Rows`, implements `V1Reader` for the reads generation needs beyond them (listed tools, stored
specifications, saved credentials), and states what only it knows in a `V1ImportProduct`: the
credential store it reads, the OAuth clients and callback v1 used, who an org connection's
account is for, whether it runs v1's local (stdio) MCP servers, and its own wording. It then
writes v2 through its own product.

The one read it does itself is `fetchSpecification`, which fetches a specification v1 stored as
its URL, as v1 fetched it. A product passes it as its reader's `specification`, with its own
HTTP client.

Errors and the stale categories Cloud persists in its reports are in
`@executor-js/v1-import/contracts`; the category list only grows.
