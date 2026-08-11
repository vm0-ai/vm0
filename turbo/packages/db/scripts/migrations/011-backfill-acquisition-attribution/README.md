# Acquisition attribution backfill

This one-shot script copies historical first-touch acquisition data into the
nullable `org_metadata.acquisition_*` columns introduced by migration 0889.

Sources are deliberately limited to durable first-party copies:

1. Clerk `privateMetadata.signup_attribution` for the current membership that
   was created with the organization.
2. Stripe customer and subscription metadata linked from `org_metadata`.

Compatible fields from those sources are merged. If the same field has
different values, the organization is reported as a conflict and is not
written. PostHog is not used because historical events before org ID capture
cannot be mapped back to an organization without guessing which member's
acquisition should own the organization.

The script is dry-run by default. It checks that every acquisition column is
present before reading targets. Apply mode only updates rows whose
`acquisition_recorded_at` is still null, making retries idempotent and keeping
live first-touch writes authoritative.

Run it through the manual **Backfill Acquisition Attribution** GitHub Action.
Review the dry-run summary and sanitized JSON artifact before selecting
`mode=apply` and `confirmed_apply=yes`.
