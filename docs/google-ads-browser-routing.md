# Google Ads browser conversion routing

Browser conversions use the captured campaign's verified Google Ads customer.
`@okouai/core/google-ads-account` mirrors the campaign registry in
`vm0-marketing/vite-ssr/app/lib/googleAdsAccounts.ts`, verified against Google Ads
on 2026-09-09. Register a newly verified campaign in both repositories before
expecting its conversions. Campaign names, UTM names and product domains do not
establish ownership; missing, unknown or conflicting IDs remain unresolved.

Signed-in onboarding and checkout events resolve ownership through
`POST /api/attribution/google-ads-account`. A saved Clerk first touch is
authoritative, including an unresolved or malformed saved touch. The request's
captured attribution is used only when no first touch has been saved. Signup
uses the account returned by the existing signup attribution endpoint.

| Event                                    | Customer 1001302527                   | Customer 7935750692                                  |
| ---------------------------------------- | ------------------------------------- | ---------------------------------------------------- |
| Signup, onboarding start, checkout start | Its own website action                | Its own website action                               |
| Paid invoice, product milestone          | Existing offline UPLOAD_CLICKS action | Its own website action and existing offline fallback |

Paid responses resolve the invoice's attribution snapshot as a whole. Only an
invoice without advertising attribution can use the organization's saved
acquisition campaign. An invoice click without a campaign cannot borrow the
organization's campaign. The API omits the optional browser paid payload unless
the resolved customer is 7935750692; milestone responses likewise return no
browser milestones for other or unresolved customers. This also prevents
already-open older clients from firing those new-account actions.

New clients require the account decision before firing a website conversion.
Unresolved attempts do not advance delivery markers. The existing milestone
baseline policy remains: events already earned on a browser's first resolved
sync are historical, and historical recovery uses the offline path. Existing
transaction IDs and per-action browser deduplication keys are preserved.

The new response fields are optional so older API responses remain readable.
A new client receiving an old response or a 404 from the new resolver withholds
the conversion. Old clients still accept the existing request and response
shapes. Already-open older clients retain their old signup/onboarding/checkout
JavaScript until refreshed; no force-upgrade floor is changed in this patch.

Historical recovery is a separate controlled operation. Reconcile original
clicks, event times and prior delivery evidence; preserve the original transaction
ID and send only to its confirmed account/action. API acceptance is not proof
that Google ultimately attributed the conversion. Persist the request receipt
and check the Data Manager processing status. Neither this code change nor a
browser refresh replays historical conversions automatically.
