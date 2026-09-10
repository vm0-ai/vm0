# Marketing privacy choices (DCF-552)

The canonical API stores anonymous and personal privacy choices separately from
signup attribution. An advertising identifier, existing account, Stripe metadata,
or old frontend payload never establishes consent. This is the state/API
foundation for [#33275](https://github.com/vm0-ai/vm0/issues/33275); marketing
clients and delivery guards must be connected before the new choice is launched.

## API contract

The contract is `@okouai/api-contracts/contracts/privacy-choices`. Account routes
accept Clerk sessions without requiring an organization, email form, or additional
identity verification. Anonymous routes need no login. All responses are uncached.

| Route                                 | Credential                                   | Behavior                                                                              |
| ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /api/privacy-choices/anonymous` | None                                         | Creates a privacy-only bearer token and an unknown state, optionally saving a choice. |
| `GET /api/privacy-choices/anonymous`  | Privacy token in `Authorization: Bearer ...` | Reads the latest state; a GPC signal persists an opt-out.                             |
| `PUT /api/privacy-choices/anonymous`  | Privacy token                                | Saves a choice, including after the browser is associated with a person.              |
| `GET /api/privacy-choices`            | Clerk session                                | Reads the person's choice across organizations; a GPC signal persists an opt-out.     |
| `PUT /api/privacy-choices`            | Clerk session                                | Saves the person's choice.                                                            |
| `POST /api/privacy-choices/associate` | Clerk session; `anonymousToken` in JSON body | Associates the latest server-held browser choice with the current person.             |

Explicit writes contain `source: "explicit"`, `policyVersion: "2026-09-10"`,
`expectedRevision`, and `purposes` with `saleSharing`, `advertising`, and
`marketingAnalytics`, each `granted`, `denied`, or `unknown`. A new subject uses
`expectedRevision: null`; subsequent choices carry the revision observed when
the choice was made. GPC writes need only `{ "source": "gpc" }`. `Sec-GPC: 1`
overrides an explicit grant on any privacy route, including reads and association.

The API validates preference requests and versions; it does not attest Termly's
dashboard configuration or infer a human action from an arbitrary `dataLayer`
event. The CMP adapter must send explicit writes only for a verified corresponding
choice, never a default tag configuration or an automatically replayed event.

## Ordering and evidence

- Missing or unverified state allows neither advertising nor marketing analytics.
  Each allowed purpose also requires `saleSharing: granted` under the agreed
  conservative policy. Sale/sharing denial and GPC disable both purposes.
- Server-generated UUID revisions prevent an older grant from overwriting a
  withdrawal, including across anonymous/account association. Client clocks do
  not establish ordering. Stale grants return `409`; clients must not rebase
  them automatically. A full withdrawal is accepted even with a stale revision.
- GPC remains persisted when the header later disappears. A later explicit
  opt-in requires the current revision and no active GPC. Repeated GPC reads do
  not churn revisions or erase its source.
- Association reads the latest anonymous record inside the same transaction as
  the personal update. A verified initial choice may establish a new personal
  state. An existing choice can only become more restrictive through association.
  A token already associated with another person cannot be rebound; a shared
  browser must create a new receipt when changing accounts.
- Linked tokens resolve the same personal state, so a later anonymous withdrawal
  also reaches that person. Restoring a personal grant requires that person's
  Clerk session and the current revision; a linked browser token can restrict
  consent without login but cannot restore it on its own. Privacy tokens authorize only privacy preferences;
  responses do not disclose the account identifier, email, or token hash.
- Current state and an immutable revision record are written atomically. Evidence
  contains purposes, source, server time, and policy version. It contains no raw
  advertising identifiers, IP address, email, or bearer token. Clerk user deletion
  removes the personal subject and linked browser subjects, cascading to their
  revision records and invalidating their receipts.

## Browser and delivery integration

The browser adapter is a subsequent change. Store the privacy token in necessary
preference storage independently of advertising storage. Do not put it in query
strings, analytics events, or logs. Marketing, auth, and app origins under
`okou.ai` can call the canonical API using the same privacy receipt. The API
accepts `Sec-GPC` in CORS preflights. Browser cookie persistence and actual
navigation still require integration and rendered-browser verification.

Root-domain cookies cannot cross `vm0.ai` and `okou.ai`. Verify redirects and any
supported handoff explicitly. Until a receipt is safely recovered or associated,
an absent/unreadable receipt must remain unknown; click IDs and URL attribution
cannot reconstruct a grant. Stop browser tracking immediately on withdrawal,
before awaiting persistence, and keep necessary preference storage available.

The delivery change must retain the event-time subject/revision reference, bind
it to the event's actual person, check its canonical evidence against the event's
time and purpose, and reread the
latest applicable personal choice before every send and retry. A receipt alone
does not authorize delivery. Follow an anonymous subject's `linkedUserId` to the
personal choice when present. Missing history, unknown policy, unavailable reads,
and events collected without permission are suppressed. Suppression after
withdrawal must survive later opt-in; do not replay previously suppressed events.
Implement sanitized skip reasons in each delivery path, including scheduled
acquisition, Stripe, retries, and backfills. Account, payment, and security
processing remain essential operations outside these optional purposes.

## Rollout compatibility

Migration `1104_privacy_choices` adds two tables; it does not backfill historical
consent or change existing attribution schemas. Ship it before the API code.
Old API/clients do not access the new tables and remain compatible. New clients
receiving a missing/unavailable API must allow no optional tracking.

`PrivacyChoices` initially enables the preference APIs globally, consistent with
the worldwide policy. It does not enable any marketing tag or delivery guard.
Disabling the API switch returns unavailable; it never converts saved choices
into grants. Deploy the server-side delivery guards before publishing Termly's
new entry or relying on a frontend opt-out. This foundation does not close DCF-552.

## Read-only inventory, 2026-09-10

Source inspected: vm0 `43bd7ed8bfca1721590ffa85bf930cf9988f9f79` and
[vm0-marketing `bd56fdbc`](https://github.com/vm0-ai/vm0-marketing/tree/bd56fdbc1ea940f6c0c8d2a05a6b64b4538d0296).

| Integration    | Evidence and remaining verification                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Termly         | `vite-ssr/ssr/document.tsx` loads resource blocker `058a3478-08ac-4f2f-a9c4-5b357bbe7433`. Dashboard regional/default settings, published version, sale/sharing control, GPC handling, and actual interaction events remain unverified.            |
| Google Ads     | Marketing environment defaults contain `AW-18144854014` and `AW-18407336975`. The document configures Google tags before its load listener; inspect real requests under basic consent mode after integration.                                      |
| GA4            | Browser and server source use `G-758ZHVCJHK`. Live Admin API access lists only property `542055948`, stream `15101991838`, measurement ID `G-WR503B0QNY`. This cannot establish the deployed stream's Ads links, personalization, or RDP settings. |
| PostHog        | Browser provider and server delivery use `https://j.okou.io`; inspect both browser consent transitions and server capture. Keep optional marketing analytics distinct from essential product/security processing.                                  |
| Impact         | Browser attribution uses `okou_impact`, `im_ref`, and `im_ref_at`; server delivery calls `api.impact.com/Advertisers/...`. Runtime configuration and deployed partner delivery must be checked.                                                    |
| Plausible      | The marketing document also loads a Plausible script, defaulting to `pa-eEj_2G8vS8xPlTUzW2A3U.js`. Include this additional website-analytics destination in the deployed inventory and purpose mapping.                                            |
| Server senders | Google Data Manager, GA4 Measurement Protocol, PostHog capture, acquisition cron, and Stripe/Impact delivery need the shared state and event-time checks in the next change.                                                                       |

The managed `okou.ai` page extraction succeeded, but it is not a network capture
or proof of consent behavior. Direct Termly resource inspection was unavailable
in this runtime. Retain published CMP configuration, screenshots, sanitized
network evidence, and server suppression receipts during final deployment
verification; the source inventory alone does not certify compliance.
