# Connector-account Workflow Automations

This document defines account authority for connector-backed workflow event
automations. It covers the account selected for provider registration, repair,
inbound matching, and run admission. It does not define ordinary interactive
connector calls outside a workflow automation.

## Authority

The workflow owner's shared automation chat thread is the only user account
authority for an account-backed event automation. For a connector target, the
desired account is resolved in this order:

1. Use the exact sparse connector selection on the automation chat thread.
2. When no selection exists, use the owner's exact default account for that
   connector target.
3. When neither exists, the account-backed automation is unavailable.

An explicit selection is not a hint. The resolver never probes another account
or falls back to a sibling account when the selected account is unavailable.
Clearing the selection is the user action that restores default inheritance.

`workflow_automations.event_connector_id` is a derived projection of this
authority. It supports provider registration, repair, source matching, and
diagnostics; it is not a second user-authored account choice.

## Account-bound event inventory

The account-bound event classifier is shared by automation enablement, workflow
copy, and Official Workflow reconciliation.

| Connector       | Event types                                                         | Persisted projection                                                    | Provider-owned state                 |
| --------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| Gmail           | `gmail-new-message`, `gmail-label-applied`                          | relational connector ID                                                 | Gmail watch; resolved label state    |
| Google Calendar | created, updated, and cancelled calendar events                     | relational connector ID                                                 | Calendar watch and sync token        |
| Google Forms    | `google-forms-response-submitted`                                   | relational connector ID and JSON `connectorId`                          | connector/form watch and cursor      |
| Google Meet     | `google-meet-transcript-generated`                                  | relational connector ID                                                 | Google Workspace Events subscription |
| Notion          | child-page-created, database-item-created, and page-content-updated | relational connector ID and JSON connector ID                           | durable pending events               |
| Stripe          | `stripe-invoice-paid`                                               | relational connector ID and JSON `{connectorId, stripeAccountId, mode}` | durable delivery and health state    |

The six-connector account classification is not the same as the physical
provider-resource classification. Only Gmail, Google Calendar, Google Forms,
and Google Meet own a per-user watch or subscription that the shared physical
reconciler creates, renews, and removes. Notion receives global webhook events
and fans them into connector-scoped durable work. Stripe also receives global
webhook events and maintains connector-scoped durable deliveries.

## Lifecycle convergence

Every authority-changing lifecycle path reprojects affected automations before
provider state is treated as current:

- event automation creation and enablement;
- thread connector selection set and clear;
- first account creation and automatic default assignment;
- explicit default-account changes;
- reconnect and external-identity changes;
- account deletion and sibling default promotion;
- workflow copy;
- Official Workflow installation and reconciliation;
- provider ingress repair; and
- scheduled provider-resource repair where the provider owns renewable state.

Selection/default/account mutations and workflow copy lock the affected account
target while resolving and persisting projections. Provider network work is
idempotent and remains provider-owned. A local authority change does not become
dependent on a successful provider HTTP request; later lifecycle or scheduled
repair converges external resources.

Workflow copy does not copy sparse connector selections. Copied automations
resolve from the destination workflow's shared automation thread, which
therefore inherits the owner's current default until the user makes an explicit
selection. Relational and strict JSON projections are updated in the copy
transaction before the copied automation is exposed.

Official Workflow reconciliation prepares provider-specific event config and
resources outside its final persistence transaction. Before accepting that
prepared state, it locks every current and next account-bound connector target,
resolves authority again, and compares the exact projection. An authority
change during preparation supersedes the stale attempt; compensation removes
unused prepared provider state and a retry prepares from current authority.

## Exact ingress source

Provider ingress carries the exact source connector as run-scoped material.
This source is evidence about where the external event arrived; it does not
choose the user's account.

Before run admission, account-backed ingress requires the exact provider source
to agree with the automation's current projection. Delayed work from a former
account is acknowledged or terminally skipped according to the provider's
delivery model, but it does not dispatch through a current automation.

After equality is established, the exact source ID is passed into run admission
as `connectorSourceId`. Run credential materialization validates that exact
source. Ingress and repair never insert, replace, or clear a sparse thread
connector selection.

## Provider-specific convergence

- Gmail resolves labels with the projected account and retains a physical watch
  only while that exact account has an enabled consumer.
- Google Calendar scopes watch and sync-token state to the projected account and
  calendar.
- Google Forms scopes watch/cursor state to the projected connector and form.
  Changing the source invalidates the old cursor before the new account is
  seeded.
- Google Meet scopes Workspace Events subscriptions to the projected organizer
  account.
- Notion invalidates durable pending events when their connector projection is
  no longer current.
- Stripe validates connector ID, external Stripe account ID, and live/test mode
  as one binding. A non-null mismatch fails closed.

An unavailable required account prevents enablement or dispatch. Cleanup that
lags behind an authority change cannot authorize stale delivery because ingress
still requires exact projection equality.

## Non-account event sources

The following workflow events are not account-bound external sources:

- GitHub App deployment, issue comment, pull request, review, workflow job, and
  workflow run events;
- `chat-run-finished`; and
- generic `webhook-received` events.

These ingress paths do not supply a user connector account as
`connectorSourceId`. Their eventual runs continue to materialize ordinary
connector credentials from the automation chat thread's selections and exact
defaults. Their external event identity remains the GitHub App installation,
source chat run, or webhook credential respectively.

The abandoned native `strapi-entry-published` event integration was removed in
[#30965](https://github.com/vm0-ai/vm0/pull/30965). The general Strapi connector
is independent of this event-source authority model. Removed event behavior is
not retained or covered by a tombstone test.

## Persisted compatibility

The relational projection is nullable so a new API can repair rows written by a
previous version and an old API can ignore the additive column. Provider JSON
representations differ because their pre-existing schemas differ:

- Gmail, Google Calendar, and Google Meet keep connector identity out of their
  strict event config and use only the additive relational projection.
- Google Forms and Notion retain their JSON connector mirrors alongside the
  relational projection.
- Stripe retains its strict JSON connector/account/mode binding alongside the
  relational projection.

Readers tolerate and repair legacy null relational projections. Existing JSON
mirrors, nullable state, and repair paths remain a rolling-deployment boundary;
they must not be removed solely because current writers converge immediately.

A cleanup requires both:

1. production evidence that no supported old API version can still read or
   write the legacy representation, including rollback targets; and
2. persisted-state evidence that rows and durable work needing the legacy
   repair path have drained or been migrated safely.

Without both measurements, retain compatibility and track contraction as a
separately gated change. See
[Deployment compatibility](./deployment-compatibility.md) for the general
old/new reader and writer rules.
