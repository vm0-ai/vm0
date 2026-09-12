# Marketing privacy implementation rollback (DCF-552)

The runtime implementation from [#33283](https://github.com/vm0-ai/vm0/pull/33283)
and [#33436](https://github.com/vm0-ai/vm0/pull/33436) is withdrawn while the
technical approach for [#33275](https://github.com/vm0-ai/vm0/issues/33275) is
reconsidered. This does not complete the privacy remediation.

## Application behavior

- The anonymous/personal privacy-choice endpoints, marketing delivery
  authorization endpoint, and `PrivacyChoices` feature switch are removed.
- Signup attribution no longer records GPC in the withdrawn privacy store or
  issues capture receipts. The signup contract and attribution/Impact checkout
  paths return to their behavior before these two PRs.
- New marketing and Impact privacy receipt/person metadata is no longer
  propagated to checkout or future subscription snapshots. Existing metadata
  is not erased by this rollback.
- Existing browser consent behavior, Termly configuration, Google/Impact
  tracking, and marketing senders are outside this rollback.

The companion [marketing PR #680](https://github.com/vm0-ai/vm0-marketing/pull/680)
requires the withdrawn authorization API. Its current guards must not be
deployed against this rollback: they would suppress optional delivery when the
API is unavailable. A revised implementation needs a new coordinated rollout.

## Retained database state

Migrations `1108`, `1109`, and `1110` have already shipped. Their SQL, snapshots,
journal entries, tables, trigger, and permanent consistency coverage are retained.
The Drizzle schema remains aligned with the deployed database and no new schema
migration is needed. Outgoing API instances can finish against the same schema
while the rollback deploys.

Existing privacy choices, revision evidence, and capture receipts are preserved
without new application writers. Account deletion still removes personal and
linked anonymous choices and cascades to their revisions and receipts. Physical
table retirement or reuse is a separate schema change after the outgoing API
has drained and the replacement design is decided.
