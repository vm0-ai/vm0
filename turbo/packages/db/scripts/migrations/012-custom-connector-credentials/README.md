# Custom connector credential backfill

This permanent operational migration reconciles historical Custom connector
credentials from `org_custom_connector_values` and
`org_custom_connector_secrets` into connector-owned rows in `secrets` and
`variables`.

The migration is non-destructive: it never updates or deletes either legacy
source table. It copies stored-secret envelopes directly for secret fields and
uses AWS KMS to decrypt only declared variable fields before writing their
plaintext shared targets.

## Safety model

- Dry-run is the default. `--migrate` enables target repairs.
- Normalized `secret:secret` values take precedence over the historical
  single-secret fallback, matching the deployed reader.
- Only exact member connections whose auth mode and storage version match the
  current manual definition are candidates.
- KMS runs before database locks. Migrate mode then locks the definition,
  member connection, and source row in writer order and rejects changed input.
- Reports contain outcome counts, source-table names, and opaque source-row
  UUIDs only. They never contain credential values, field names, connector
  names, organization IDs, user IDs, or connection IDs.
- A migrate run never reports readiness. Run a new complete dry-run from the
  beginning after repairs; only that run can set `ready` to `true`.

Do not run migrate mode in production until #26240 is deployed and every older
API writer has drained. Do not begin #26242 until a complete production dry-run
reports `ready: true` and zero blocking differences.

## Usage

Run from `turbo/`:

```bash
pnpm --filter @vm0/db exec tsx \
  scripts/migrations/012-custom-connector-credentials/backfill.ts \
  --batch-size 100 \
  --report-path ./custom-connector-credential-backfill.json
```

After reviewing a complete dry-run, add `--migrate` to repair missing or
mismatched shared targets. The repository workflow
`Backfill Custom Connector Credentials` supplies the production database and
KMS credentials and requires a separate apply confirmation.

`--batch-size` controls the maximum keyset page size and must be between 1 and
1,000. Every completed page checkpoints the sanitized report. If a run fails,
resume after the last completed row with the report's cursor:

```bash
pnpm --filter @vm0/db exec tsx \
  scripts/migrations/012-custom-connector-credentials/backfill.ts \
  --cursor 'values:00000000-0000-4000-8000-000000000000' \
  --batch-size 100 \
  --report-path ./custom-connector-credential-backfill-resumed.json
```

A resumed scan is intentionally not a readiness certificate. Once repairs and
resumes finish, run one final dry-run without `--cursor`.

## Outcomes

`target_missing`, `target_mismatch`, `source_changed`, and
`invalid_definition` are blocking differences. Migrate mode repairs the first
two, reports changed sources as retryable races, and leaves malformed
definitions for manual review. Other classifications describe legacy residue
that the current runtime does not execute, including missing or incompatible
member parents, removed or wrong-kind fields, malformed envelopes, OAuth
transitions, and suppressed single-secret fallbacks.
