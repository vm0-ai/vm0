# Testing External Behavior

Good product tests describe the contract that a user can rely on. They should
not describe the private shape of the code that happens to implement that
contract today.

The stable facts are at the boundary:

- A user can click, type, upload, and read what the product renders.
- An API client can call an endpoint and read the response, headers, and
  externally observable side effects.
- A webhook provider can deliver an event to the public webhook endpoint.
- A runner or sandbox can call the endpoint it is given by the product.

Database rows, schemas, service functions, queues, and helper-only seeders are
not external behavior. They are implementation details. They change when the
product is refactored, when storage is normalized, when a queue moves, or when a
service boundary is renamed. A test that depends on them can pass while the user
contract is broken, or fail while the user contract is still correct.

## Platform Tests

Platform tests exercise the product as a user sees it.

Use page interaction to create state:

- Sign in as the relevant user.
- Use the page to click controls, submit forms, upload files, and navigate.
- Use public webhooks or mocked external providers only where the user journey
  naturally depends on them.

Use page interaction to verify results:

- Assert visible text, enabled or disabled controls, navigation, files,
  notifications, and other rendered state.
- Do not query the database to prove that a page interaction worked.
- Do not call a service to skip part of the page workflow.

The page is the contract. Component state, DB rows, and service internals are
not the contract.

## API Tests

API tests exercise the product as an API client sees it.

Use production endpoints to create state:

- Call the same API endpoint that a client, webhook provider, runner, sandbox,
  or integration would call in production.
- Mock only external systems such as Clerk, Stripe, Slack, Telegram, GitHub,
  Google, model providers, S3/R2, Axiom, and email providers.
- Wrap endpoint calls in helper functions when that keeps the test readable, but
  keep those helpers as API clients.

Use production endpoints to verify results:

- Assert response status, response body, headers, follow-up endpoint responses,
  and externally visible provider calls.
- Prefer a follow-up `GET`, list endpoint, webhook delivery, or runner callback
  over a direct DB assertion.
- For API tests, operating on DB schemas, asserting DB schemas, calling services,
  or asserting service outputs is testing internal implementation.

For API tests, the only trustworthy product boundary is the API endpoint. DB
tables and services are useful implementation tools, but they are not the API
contract.

## Exceptions

An exception is valid only when production cannot construct the state through an
external boundary.

Examples:

- A pre-provisioned private registry archive that has no user, webhook, runner,
  or admin API for creating its storage version.
- A time-compression hook for a multi-second timeout branch where the production
  behavior is already exercised and the test only shortens the wait.
- A deliberately corrupted internal row that production writes atomically and no
  external caller can create.

When an exception is needed, keep it narrow:

- Put the direct internal access in the smallest possible test scope.
- Add an inline reason that names the missing production construction path.
- Still verify the externally observable result through the endpoint whenever
  possible.

The exception is a fact about missing product surface, not a shortcut for
convenience.
