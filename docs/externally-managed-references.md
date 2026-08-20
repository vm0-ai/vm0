# Externally Managed References

An externally managed reference is an identifier held by one component while
another authority owns the referenced entity's identity and lifecycle. The
consumer cannot guarantee that the entity still exists, remains visible, or is
usable when the reference is resolved.

The boundary is defined by authority, not transport or storage:

- A provider account ID is externally managed even when it is persisted in our
  database.
- A built-in connector slug is externally managed by the accepted connector
  catalog even when a local row contains the slug.
- A request body is external input, but it is not necessarily an externally
  managed reference.
- A record owned by the current service is internal even if another service
  originally supplied some of its fields.

Storing or caching a reference does not transfer ownership of the referenced
entity to the consumer.

## Classify the Boundary Before Handling Failure

"External data" is too broad to imply one failure behavior. Classify the value
or operation before deciding whether to reject, continue, or fail:

| Category                     | Example                                                    | Expected behavior                                                                                           |
| ---------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Untrusted input              | API body, webhook payload                                  | Validate against the input contract; reject or quarantine invalid input as that contract requires.          |
| Externally managed reference | Stored provider resource ID or connector catalog slug      | Resolve against the current authority; an entity that no longer resolves is unavailable.                    |
| Required remote operation    | Provider API call needed to complete a request             | Surface or retry its failure according to the operation contract; do not report every failure as not found. |
| Local invariant              | Locally owned row shape, foreign key, or internal protocol | Let violations fail so corruption and programming errors remain visible.                                    |

These categories can meet at one boundary. For example, an API may first
validate the syntax of a connector slug supplied by a caller and then resolve
that well-formed reference against the current connector catalog. Invalid
syntax and a missing catalog entry are different results.

## Resolution Rule

Code that consumes an externally managed reference must represent an expected
resolution miss as a normal domain result such as `not_found`, `unavailable`,
or `undefined`. The absence of that one entity must not, by itself, turn an
otherwise valid list, read, or execution into an internal server error.

- A collection omits an entity that no longer resolves and continues with
  valid siblings.
- A direct lookup returns the domain's normal missing or unsupported result.
- An optional capability proceeds without that entity when the product
  contract permits it.
- A required capability may stop with its specific unavailable result; the
  reference rule does not make every dependency optional.

Do not silently reinterpret or substitute an identity. A missing reference is
not permission to select a similarly named entity or a different account.
Product-defined preference resolution, such as falling back from a deleted
preferred account to the current default, must be explicit and independently
authorized.

## Representation Versus Existence

Validate representation and resolve existence separately:

1. Parse an untrusted or deliberately raw stored value into its identifier
   type.
2. Resolve the typed identifier against the authority that owns the entity.
3. Treat only the authority's expected missing, removed, hidden, revoked, or
   incompatible result as unavailable.

A parser such as `safeParse` proves only that a value has the right shape. It
does not prove that the referenced entity exists. Conversely, do not convert a
database failure or a violated local storage contract into an external
resolution miss. If the local schema promises that a persisted value is a
valid typed identifier, a malformed stored value is a local invariant failure,
not ordinary catalog churn.

## Security Must Fail Closed

An unresolved external reference must grant nothing. Validate identity,
current existence, and authorization before granting capabilities,
credentials, targets, or ownership. Continuing without an unavailable entity
is safe only when the remaining behavior was already authorized.

For example, a removed connector catalog entry cannot be converted into a
custom connector or allowed to expand an agent's connector scope.

## Error Boundaries and Observability

Handle only the authority's explicit resolution outcomes. Let unrelated
failures propagate, including:

- database connectivity and transaction failures;
- programmer errors and broken internal contracts;
- impossible states protected by local schema constraints;
- remote failures that prevent the authority from answering whether an entity
  exists, unless the product defines a specific cached or degraded mode.

Do not wrap an entire route or workflow in `try/catch` and call every exception
"unavailable." Record enough structured context to diagnose a stale or invalid
reference, without logging credentials, tokens, or sensitive provider data.

## Testing

Test the behavior at a real API, CLI, or runtime entry point:

- use a well-formed reference to an entity that the authority no longer
  exposes;
- verify the normal unavailable result rather than a 500;
- verify valid siblings still work where the operation is a collection;
- verify the missing entity grants no capability or credential;
- separately test malformed caller input and local invariant failures according
  to their own contracts.

## Relationship to Fallbacks

Returning an unavailable result for a missing externally managed entity is
normal reference resolution, not rolling-deployment compatibility. Any action
taken after that result, such as choosing a default account or using cached
data, is a separate fallback decision and must satisfy
[Fallbacks to avoid](./fallback.md).
