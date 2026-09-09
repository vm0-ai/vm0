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
acquisition first touch. The current organization's administrator can refresh an
existing Stripe customer, and customer creation reads the actual purchaser's
click. Both paths use the existing per-organization customer advisory lock to
avoid racing Stripe customer creation and metadata updates. Unrelated Stripe
metadata is preserved. No arbitrary organization member is selected for referral
attribution. Payment availability is retained if optional Clerk enrichment fails.

Stripe customer fields:

- `impact_click_id`: the referral click ID
- `impact_click_at`: its original ISO timestamp

The marketing webhook validates the configured referral window at payment time
and freezes its delivery attribution on the invoice/PaymentIntent. Subscription
payments use tracker `87218`; **all non-subscription purchases** use Deposit
tracker `87219` under program `57423`. Mixed invoices are split by line item, and
refunds adjust the matching conversion. Conversion enablement, credentials,
provider duplicate handling and live/test verification are documented in the
companion marketing PR's `vite-ssr/docs/impact-conversions.md`.

This change needs no database migration, Impact credentials or production
configuration in the main repository. No real payment or conversion is performed
by the PR or its tests.
