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
- Route navigation and hard reload wait up to 15 seconds for ClerkJS bootstrap
  readiness before ordinary UI assertions begin
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

A terminal bootstrap timeout reports only whether ClerkJS is absent or unloaded
and the last Clerk request's method, masked pathname, and coarse status. Query
strings, hosts, headers, bodies, and Clerk resource identifiers are removed
before the diagnostic reaches workflow redaction.

## Deterministic browser coverage

The `auth-v2.spec.ts` project covers:

- base and nested sign-in/sign-up routes, hard refresh, desktop rendering, and
  v1/v2 route coexistence;
- all ten supported platform locales, a French mobile viewport, light/dark
  theme switching, keyboard focus, live announcements, and overflow safety;
- password sign-in through Clerk Device Trust email verification, same-origin
  redirect preservation, and organization continuation when the development
  session produces the Clerk organization task;
- email-code sign-in with Clerk's development verification code and completion;
- password reset through email verification and a new password;
- progressive sign-up with email, password, names, legal consent, email
  verification, and session activation;
- an existing Clerk session selecting its account and continuing without any
  organization-creation affordance;
- Google One Tap invocation only at the base-route boundary, including its
  FedCM initialization and terminal-moment contract, Google OAuth's HTTPS
  handoff boundary, and passkey cancellation/fallback when those methods are
  enabled in the development Clerk configuration.

Error recovery, resend cooldowns, request coalescing, editable identifiers, and
form validation stay in platform entry-point integration tests. The
provider-backed Playwright lane covers happy paths only so it does not create
avoidable Clerk requests or rely on synthetic provider responses.

## Exact-preview and manual checkpoints

These checks cannot be completed deterministically by the CI lane and remain
explicit QA checkpoints on the final PR's exact preview SHA:

1. Complete Google account chooser/consent, OAuth callback, and One Tap
   credential exchange. Google/FedCM owns those surfaces and CI has no durable
   external Google identity.
2. Complete a hardware-backed passkey ceremony. CI asserts cancellation and
   local fallback only when the development Clerk instance exposes passkeys;
   otherwise it records the configuration limitation.
3. Let a real email verification expire by provider wall clock and confirm the
   recovery flow. Entry-point integration tests cover the provider error
   boundary, while CI uses the real API for successful completion only.
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
