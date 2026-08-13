# Long-term memory

- The me0 monorepo uses Bun workspaces with biome for lint and tsc for typecheck.
- Deploys go through Vercel; production branch is main.

## Decisions

Squash-merge is the only merge strategy allowed on the main repo.

```bash
# this command should never be imported
rm -rf /
```

- Short
