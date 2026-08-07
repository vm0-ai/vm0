# CLI and Runner E2E Testing

## Scope

Deployed E2E tests exercise the product exactly through supported user-facing
entry points. The current suite covers:

- the packaged `zero` binary through unauthenticated `--help` and `--version`
  smoke checks;
- Clerk sign-up and sign-in through the hosted form UI;
- onboarding, chat submission, runner dispatch, and the assistant result through
  the deployed web application.

An E2E test must not call `/api/test/*`, mint a test-only API token, write the
database directly, or use an internal fixture endpoint to construct or inspect
state. Create state through the same product UI or supported public API that a
user would use.

If a behavior needs precise database state or an external-service mock, cover it
in an API integration test instead. API tests may mount the narrow fixture routes
they need by passing them explicitly to `setupApp({ routes })` or
`setupAppWithRoutes`. Test routes must never be added to the deployed `ROUTES`
registry.

## Test boundaries

Keep each layer focused:

- CLI smoke checks verify that the shipped package exposes the supported binary
  surface without authenticating.
- Browser E2E verifies third-party Clerk form integration.
- Playwright verifies the deployed product journey, including the real preview
  API and runner fleet.
- API integration tests own deterministic error cases, state matrices, provider
  mocks, and fixture-only setup.
- Crates tests own runner and sandbox behavior that does not require the product
  journey.

## Adding deployed E2E coverage

Before adding a case, verify that it:

- begins at a supported product entry point;
- creates prerequisites through product behavior;
- asserts user-visible output rather than internal rows or logs;
- uses unique user-visible names when parallel execution can collide;
- leaves cleanup to the product lifecycle or an idempotent public operation;
- does not depend on a route, credential, environment flag, or database table
  that exists only for tests.

When those constraints make a scenario impractical, place the scenario at the
API integration or crates layer rather than introducing a deployed test hook.
