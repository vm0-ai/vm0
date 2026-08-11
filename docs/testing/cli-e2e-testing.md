# CLI and Runner E2E Testing

## Scope

Deployed E2E tests exercise the product exactly through supported user-facing
entry points. The current suite covers:

- the packaged `zero` binary through unauthenticated `--help` and `--version`
  smoke checks;
- Clerk sign-up and sign-in through the hosted form UI;
- onboarding, chat submission, runner dispatch, and the assistant result through
  the deployed web application;
- connector firewall placeholder and authentication behavior through the
  deployed preview API, runner, sandbox, and proxy.

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

## Running runner E2E tests

The BATS files under `e2e/tests/03-runner` are CI-only and cannot be run from a
local checkout. They depend on temporary Clerk organizations and API tokens,
the pull request's deployed API and app previews, and the preview runner fleet
provisioned by the `cli-e2e-03-runner-*` jobs in `.github/workflows/turbo.yml`.
There is no supported local setup for those credentials and services.

Push runner E2E changes to a branch and use the pull request pipeline to run
and validate this suite. Do not treat a local `./e2e/run.sh` invocation as
validation for `03-runner`; running the script without file arguments also
selects the CI-only runner tests.

## Adding runner BATS tests

Runner BATS files live in `e2e/tests/03-runner`. They share the accounts and
public device-flow tokens prepared by the runner E2E workflow, then create and
clean up their own agents, threads, and connector connections through public
`/api/zero/*` endpoints.

Use a different organization-scoped connector slug in each file that can run in
parallel. Assert sandbox-visible output and vm0-owned telemetry; do not treat an
external provider's exact response status or body as the test oracle.

The workflow discovers the checked-in BATS files, weighs each file by its test
count, and assigns whole files to at most twelve non-empty shards. New files are
included automatically. Keep setup and teardown self-contained within a file so
the shard planner can move it without introducing cross-file ordering.
