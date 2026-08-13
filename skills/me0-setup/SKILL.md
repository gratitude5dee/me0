---
name: me0-setup
description: Install, verify, and troubleshoot me0 (init / doctor / verify runbook). Use when the user asks to set up me0 or when me0 tools are failing.
---

# me0-setup — bootstrap runbook

## Install
```bash
bun install && bun link me0-cli me0-mcp   # from the me0 repo
# storage: any MongoDB. Fastest local option:
docker run -d --name me0-mongo -p 27017:27017 mongo:8
me0 init --uri mongodb://127.0.0.1:27017 --user <user_id> --name "<Display Name>"
```

`me0 init` provisions the database (collections, validators, indexes), seeds the identity card, and wires detected harnesses (Codex `config.toml` + `AGENTS.md`; Claude Code via this plugin).

## Verify (gate: exit 0)
```bash
me0 verify   # write → recall → pack round-trip; exit 0 = every seam healthy
```

## Troubleshoot
```bash
me0 doctor   # checks config, MongoDB connectivity, harness wiring
```
Common fixes: MongoDB not running (`docker start me0-mongo`); URI drift (re-run `me0 init --uri ...`); env overrides `ME0_MONGODB_URI` / `ME0_USER_ID` take precedence over `~/.me0/config.json`.

## Export / import
```bash
me0 export --out ./me0-backup   # JSONL per collection, human-readable
me0 import --in ./me0-backup/memories.jsonl
```
