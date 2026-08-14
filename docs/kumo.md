# Native KumoRFM backend

`packages/me0-rfm` scores the predictive tasks from [`goal.md` §12](goal.md)
(`retrieval_utility`, `prefetch`, `forget`) with one of two interchangeable
backends behind a single `PredictionBackend` interface:

- **`heuristic`** (default) — deterministic, zero-dependency, no API keys.
- **`kumo`** — real [KumoRFM](https://kumorfm.ai) predictions via the official
  [`kumo-rfm-mcp`](https://github.com/kumo-ai/kumo-rfm-mcp) MCP server.

Both write the same document shape into the `predictions` collection, so
retrieval ranking, pack assembly, and dream tiering consume either unchanged.
The only difference is the `model` field: `heuristic` vs `kumo-rfm-2`.

## Why an MCP client bridge

Kumo ships no TypeScript SDK, and its stable REST surface targets the
enterprise SaaS product (trained predictive queries), not KumoRFM's
training-free in-context predictions. The officially supported KumoRFM
integration surface is the Python `kumoai` SDK and the `kumo-rfm-mcp` MCP
server built on it. me0 already speaks MCP (`@modelcontextprotocol/sdk`), so
the bridge spawns the official server over stdio and drives it as an MCP
client — no Python code inside me0, and Kumo maintains the SDK half.

## Setup

1. Install the official server (Python ≥ 3.10):

   ```bash
   pip install kumo-rfm-mcp
   ```

2. Get a free API key at [kumorfm.ai](https://kumorfm.ai) and export it:

   ```bash
   export ME0_KUMO_API_KEY=<your key>   # or KUMO_API_KEY
   ```

3. Run it:

   ```bash
   me0 rfm predict --backend kumo
   ```

## Configuration

| Env var | Meaning | Default |
| --- | --- | --- |
| `ME0_RFM_BACKEND` | Backend when `--backend` is not given: `heuristic` \| `kumo` | `heuristic` |
| `ME0_KUMO_API_KEY` | KumoRFM API key (falls back to `KUMO_API_KEY`) | — |
| `ME0_KUMO_MCP_COMMAND` | Command that spawns the stdio server | `python -m kumo_rfm_mcp.server` |

## What the bridge does

1. Exports the user's flat tables (always redacted — structure only, no free
   text leaves the store) and converts them to CSV.
2. `update_graph_metadata` — registers the tables (primary keys, time
   columns) and their foreign-key links, then `materialize_graph` builds the
   LocalGraph. No pre-created index or graph is needed on Kumo's side; the
   graph is materialized per run from the exported tables.
3. `predict` — runs the PQL queries from `packages/me0-rfm/src/pql.ts`:
   binary tasks (`forget`, `retrieval_utility`) per memory (chunked ≤ 1000
   indices per call) and `prefetch` as a `LIST_DISTINCT` recommendation per
   user.
4. Replaces all prior predictions (any model) for the user's memories and
   inserts the fresh scores, so exactly one score exists per (memory, task)
   and retrieval ranking stays deterministic — the latest backend run wins.

The server is spawned with a minimal environment (default safe vars plus
`KUMO_API_KEY`), and the temporary export directory is deleted after each run.

## Fail-open policy

- `me0 rfm predict --backend kumo` (explicit): failures (missing key, server
  not installed, unauthorized, network) surface as a clear error with setup
  guidance. Nothing is silently substituted.
- `me0 dream --rfm` (automated): if `ME0_RFM_BACKEND=kumo` fails, the run
  falls back silently to the heuristic backend — memory never blocks the
  agent. The CLI notes the fallback in its output.

## Testing

The bridge is tested hermetically against a tiny in-repo fake MCP server
(`packages/me0-rfm/test/fake-kumo-server.ts`) spawned over stdio — no API
keys, no network. See `packages/me0-rfm/test/kumo.test.ts`.
