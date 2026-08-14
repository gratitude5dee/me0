# Using me0 with Devin

me0 integrates with Devin two ways: as an MCP server Devin can call live, and as a
session-log importer that backfills past Devin sessions into your memory graph.

## 1. Register me0 as an MCP server in Devin

Devin supports custom MCP servers at the organization level
(Settings → Integrations → MCP Marketplace → "Add custom MCP server").
Devin's MCP client speaks stdio and HTTP(S); the me0 stdio server must run on a
machine Devin can reach (Devin's own VM, or a host you expose).

### Option A — run me0 inside Devin's VM (simplest)

Add these to your repo or org environment blueprint so every Devin session has me0
available:

```yaml
initialize: |
  docker pull mongo:8
maintenance: |
  npm i -g me0 me0-mcp
knowledge:
  - name: me0
    contents: |
      # start mongo + init me0, then use `me0 op <verb> '<json>'` for memory:
      docker run -d --name me0-mongo -p 127.0.0.1:27017:27017 mongo:8 || docker start me0-mongo
      me0 init --uri mongodb://127.0.0.1:27017 --user <you>
```

Devin then uses the `me0` CLI (or `me0-mcp` over stdio) directly during sessions —
`me0 op context_pack '{}'` at session start, `me0 op episode_start/log/end` during work,
`me0 op handoff '{}'` before stopping.

Note: a fresh VM has an empty local MongoDB. For continuity across sessions, point
`--uri` at a persistent MongoDB (Atlas or your own host) instead of the local container.

### Option B — expose me0 as a remote endpoint

Run `me0 serve --a2a --host <host> --a2a-token <token> --url https://your-domain`
behind a TLS-terminating reverse proxy. Remote callers only see `world`-visibility
memories by design; this path is for federation, not full personal memory.

## 2. Import Devin session logs

Devin exposes each session's full event stream via its API/MCP
(`devin_session_events`). Export a session to JSON:

```json
{
  "session_id": "devin-<id>",
  "title": "...",
  "events": [
    { "event_id": "...", "type": "...", "category": "...", "created_at": "...", "contents": { ... } }
  ]
}
```

Then import it:

```bash
me0 import-devin --in devin-session.json
```

Mapping (deterministic, idempotent — re-import is a NOOP keyed on session id):

| Devin event                          | me0 event   |
| ------------------------------------ | ----------- |
| `initial_user_message`/`user_message` | `prompt`    |
| `devin_message`                       | `response`  |
| `shell_process_started`               | `command`   |
| `shell_process_completed`             | `command` (ok = exit 0) |
| `multi_edit_result` (writes only)     | `file_edit` |
| `mcp`/`git` category events           | `tool_call` |

The episode lands with `harness: "devin"` and is capped at 500 events / 1000 chars
per payload, like the other importers.
