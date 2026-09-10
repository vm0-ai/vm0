# Impact attribution handoff

Impact payment reporting is owned by `vm0-ai/vm0-marketing` and its existing Stripe
webhook. This companion change only captures/persists referral attribution and
passes it to Stripe; the app and API never submit Impact conversions.

The optional `impactAttribution` sibling in `POST /api/attribution/signup` carries
`{ clickId, capturedAt }`. It is separate from the strict Google Ads acquisition
schema and the immutable `signup_attribution` private metadata record. An old
client remains valid, and an old API ignores the additional request field. Deploy
this API/app change before enabling the marketing integration.

The app reads `im_ref`/`im_ref_at` on arrival, or the shared `okou_impact` cookie,
and retains the newest valid click across login in session storage. Same-click
visits preserve the original timestamp. Malformed, future-dated and 90-day-old
values are ignored. Marketing writes its cookie only after advertising consent;
its CTA forwards these fields when authentication crosses brand domains.

An authenticated user's latest click is saved as `impact_attribution` in Clerk
private metadata. Recording an Impact-only visit does not create an empty
acquisition first touch. An organization administrator also persists the click in
`org_metadata.impact_click_id` / `impact_click_at`. An atomic timestamp condition
accepts only a newer click; stale Clerk records and browser sessions cannot roll
back the organization record. Non-admin members cannot change organization
billing attribution. Google Ads retains its existing immutable first-touch fields.

Billing uses the organization record, enriched from the actual purchaser's Clerk
record when available. No arbitrary member is selected. Optional Clerk read
failures still allow billing to use the stored organization click. The existing
per-organization Stripe customer advisory lock serializes customer creation and
metadata synchronization, preserving unrelated Stripe metadata.

Stripe fields `impact_click_id` and `impact_click_at` carry the click ID and its
original ISO timestamp. Like Google Ads, server-resolved attribution is copied
into Checkout and subscription metadata; the strict client Google Ads schema
remains separate. Credits also snapshot it into invoice and PaymentIntent
metadata. In-app purchase previews freeze attribution in their signed tokens;
invitation purchases persist their snapshot with the pending purchase, keeping
confirmation and retry metadata stable. Automatic recharge invoices snapshot the
organization click when they are created.

A new eligible administrator click refreshes the Stripe customer and active
subscriptions. Stripe freezes subscription metadata into each invoice's
`parent.subscription_details.metadata`, so the new click affects future renewals
without changing existing invoice attribution. The marketing webhook reads the
purchase snapshot, never a mutable customer click. A delayed payment notification
therefore keeps the original purchase attribution. Purchases without a snapshot
are skipped; historical purchases are not backfilled.

The marketing webhook validates the agreed 30-day referral window at payment time
and freezes its delivery attribution on the invoice/PaymentIntent. Subscription
payments use tracker `87218`; **all non-subscription purchases** use Deposit
tracker `87219` under program `57423`. Mixed invoices are split by line item, and
refunds adjust the matching conversion. Conversion enablement, credentials,
provider duplicate handling and live/test verification are documented in the
companion marketing PR's `vite-ssr/docs/impact-conversions.md`.

Migration `1102_impact_attribution` adds nullable columns to `org_metadata` and
`usage_pack_invitation_purchases`; existing rows and old API writers remain valid.
Apply it with the normal vm0 deployment, deploy the API/app companion, then deploy
and enable the marketing integration after provider acceptance. The main
repository needs no Impact credentials. No production settings, real payments or
conversions are changed by the PR or its tests.
