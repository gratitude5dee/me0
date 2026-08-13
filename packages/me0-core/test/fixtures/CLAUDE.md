# Project conventions

## Code style

- Prefer conventional commits with squash-merge
- We decided to use Biome instead of ESLint
- Run `bun test` before every push
- The monorepo uses Bun workspaces

## Deployment

Always deploy from the main branch only.

Use the staging environment for smoke tests before promoting a release.

```bash
# this code fence must be skipped entirely
never import this line
```

The production database is MongoDB Atlas.
