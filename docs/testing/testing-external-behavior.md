# Testing External Behavior

This practice is about the test boundary.

Tests should not control internal implementation. Tests should give the system
the same context an external user can provide, then observe the result from the
same surface an external user can see.

This is the same context / control distinction we use elsewhere. A control-style
test says: to exercise this case, directly set the internal state to the shape I
want. A context-style test says: if a real user can bring the system into this
state, the test should do it the same way.

The context-style test is more solid because external interfaces are stable.
Internal implementation is not stable. Tables change, services split, caches
move, and state machines get represented differently. As long as external
behavior is unchanged, those implementation changes should not break tests.

## Platform

In `turbo/apps/platform`, the external user interface is the page.

So tests should construct cases through page interactions and verify results
through the page.

For example:

1. If a user clicks a button, the test clicks the button.
2. If a user types into an input, the test types into the input.
3. If a user can see a toast, list, URL, or dialog, the test asserts on that
   surface.

Do not render an internal component just because it is convenient. Do not mutate
the store directly. Do not call hooks directly. Do not assert on query cache,
component state, CSS classes, or whether an internal callback was called.

Those things may be today's implementation, but they are not the user's
interface. Testing them freezes the implementation. Later, a refactor fails the
test even though the product still works.

## API

In `turbo/apps/api`, the external user interface is the API endpoint.

So API tests should construct cases by calling APIs and verify results by
calling APIs.

That means:

1. When setting up state, call the real API that exists in production.
2. When verifying results, call an API that an external user can call.
3. Auth, validation, serialization, idempotency, permissions, and
   no-existence-leak behavior should all be exercised through the endpoint.

For API tests, the database is not the external interface. DB schema is internal
implementation.

Directly inserting, updating, or deleting DB rows tells the test about an
internal implementation detail instead of describing user behavior. Directly
selecting DB rows for assertions verifies the internal write path instead of the
result an external user can observe.

Services are not the external interface either. Calling a service to construct a
case, or asserting on a service return value, bypasses the route, middleware,
contract, auth, and request parsing. That test can pass while the real API is
still broken.

For the API project, testing the DB, mutating the DB, asserting on the DB,
calling services, or asserting on services all test internal implementation. The
only trusted boundary is the API endpoint.

## Exceptions

Exceptions should be rare.

Leave the external behavior boundary only when a case is completely impossible
to construct through the production external interface. Examples might include
some historical bad states, states that only infrastructure can trigger, or an
internal cron state with no user-facing entry point.

These are not exceptions:

1. API setup is verbose.
2. Page setup takes several interactions.
3. An existing helper can write the DB directly.
4. Calling the service is faster.

If a state can be constructed through a real endpoint or page interaction, use
that path.

When an exception is truly needed, the test should state why the production
external interface cannot construct the state and why the case is still worth
testing. Do not hide exceptions inside generic fixtures where future tests
inherit internal coupling by default.

## Lint

API test files should not import DB schema or API service files.

This lint rule is not about making code look tidy. It is a reminder that the
test is crossing the external behavior boundary and starting to control internal
implementation. Go back to the endpoint first and see whether the case can be
constructed with the real API.
