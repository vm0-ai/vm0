# 010: Custom Model Gateways

This post-deploy script migrates the `geo` workspace's existing Vercel AI
Gateway route into the additive custom gateway schema.

It:

- reuses the existing encrypted secret without decrypting or copying it;
- creates one connection with Anthropic Messages and OpenAI Responses surfaces;
- points the two existing Claude policies at the Messages surface; and
- leaves the legacy `model_providers` row unchanged for rolling-deploy
  compatibility.

The optional cleanup flag removes five explicitly approved retired provider
rows: four OpenRouter configurations and the inactive `ge o` Vercel
configuration. Foreign keys set current policy and agent references to `NULL`;
historical thread and run snapshots remain unchanged. An orphaned secret is
removed only when no legacy provider or custom connection still references it.

## Prerequisites

- `pnpm install` completed in the `turbo` directory
- Database migration `0745_harsh_shadowcat` applied
- The API/runtime changes that resolve `model_provider_surface_id` deployed
- `DATABASE_URL` points to the target PostgreSQL database

## Usage

Run from `turbo/packages/db`:

```bash
# Dry run: report the geo and retired-provider state.
pnpm exec tsx scripts/migrations/010-custom-model-gateways/backfill.ts

# Migrate geo, preserving every legacy provider row.
pnpm exec tsx scripts/migrations/010-custom-model-gateways/backfill.ts --migrate

# Migrate geo and apply the separately approved provider cleanup.
pnpm exec tsx scripts/migrations/010-custom-model-gateways/backfill.ts \
  --migrate \
  --cleanup-retired-providers
```

## Idempotency

The connection is keyed by the existing secret, surfaces are keyed by
connection and protocol, and policies are updated only while they still point
at the legacy Vercel provider. Re-running the script does not overwrite gateway
configuration that an administrator edited after migration.
