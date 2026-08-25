# Auth v2 Playwright coverage

This suite exercises the platform-owned Auth v2 UI against the development
Clerk instance. It is intentionally isolated from the legacy smoke/features
projects and from `lib/auth.ts`.

## CI contract

- Project: `auth-v2`
- Worker count: one
- Trace, screenshot, and video recording: off
- Blob and merged HTML report artifacts: off for this project; GitHub-redacted
  list output only
- Test identities: unique generation-scoped `+clerk_test` addresses
- Verification code: Clerk's documented development code, `424242`
- Cleanup: exact organizations then exact users after every test, followed by
  the existing generation finalizer if a worker or job is interrupted

The resource fixture masks every generated email and password in GitHub Actions
before browser interaction. The Auth v2 lane also streams list output through a
scoped redactor for Clerk testing-token query parameters, generated test email
addresses, and Clerk resource identifiers while preserving the Playwright exit
status. The project does not persist captured stdout to a Playwright report
artifact. Helpers and assertions do not log Clerk response bodies, user IDs,
organization IDs, credentials, or testing-token URLs.

## Deterministic browser coverage

The `auth-v2.spec.ts` project covers:

- base and nested sign-in/sign-up routes, hard refresh, desktop rendering, and
  v1/v2 route coexistence;
- all ten supported platform locales, a French mobile viewport, light/dark
  theme switching, keyboard focus, live announcements, and overflow safety;
- password sign-in, password reveal, a bounded Clerk server failure and retry,
  same-origin redirect preservation, and organization continuation when the
  development session produces the Clerk organization task;
- email-code sign-in with one initial preparation, refresh without a second
  send, cooldown enforcement, coalesced retry, edit/back, a provider-shaped
  expired-code response, `424242`, and completion;
- password reset through email code and a new password, including mismatch,
  expired-code retry, coalescing, and refresh at both reset steps;
- progressive sign-up with email, password, names, legal consent, password
  validation, exactly one automatic verification preparation, cooldown,
  coalesced expired-code recovery, edited email, refresh, and session
  activation;
- an existing Clerk session selecting its account and continuing without any
  organization-creation affordance;
- Google One Tap invocation only at the base-route boundary, including its
  FedCM initialization and terminal-moment contract, Google OAuth's HTTPS
  handoff boundary, and passkey cancellation/fallback when those methods are
  enabled in the development Clerk configuration.

Expired-code coverage fulfills the first matching Clerk verification attempt
with the provider's `form_code_expired` response. This makes recovery and
request-count assertions deterministic without waiting beyond the eight-minute
CI budget. The following retry and completion calls use the real development
Clerk API.

## Exact-preview and manual checkpoints

These checks cannot be completed deterministically by the CI lane and remain
explicit QA checkpoints on the final PR's exact preview SHA:

1. Complete Google account chooser/consent, OAuth callback, and One Tap
   credential exchange. Google/FedCM owns those surfaces and CI has no durable
   external Google identity.
2. Complete a hardware-backed passkey ceremony. CI asserts cancellation and
   local fallback only when the development Clerk instance exposes passkeys;
   otherwise it records the configuration limitation.
3. Let a real email verification expire by provider wall clock. CI covers the
   identical provider error boundary synthetically and uses the real API for
   resend and successful completion.
4. Verify VM0 branding on `app.vm0.ai`. PR app previews resolve to the Okou
   preview domain, so Okou branding is automated while the VM0 production-host
   boundary is a read-only live check.
5. Confirm forced-organization continuation on a session for which Clerk emits
   `currentTask: choose-organization`. The backend fixture creates multiple
   memberships and the suite fully asserts the chooser when the development
   configuration emits that task; Clerk instance policy controls whether it
   does so.
6. Re-run the dedicated project against the final PR preview URL and record the
   preview deployment SHA before the PR enters the merge queue. This checkpoint
   must not use a prior or sibling preview.

Desktop auth, `/sign-in-token`, legacy `/sign-in` and `/sign-up`, and the
existing Playwright authentication helper keep their existing ownership and
behavior; this suite does not replace or mutate them.
