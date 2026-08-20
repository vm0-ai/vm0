# External Data Boundaries

Data owned outside the service is not a local invariant. Provider payloads,
remote catalogs, webhook metadata, imported manifests, and persisted copies of
those values can be missing, removed, stale, or malformed independently of a
deployment.

This rule applies to externally owned entities as well as optional fields. A
built-in connector catalog entry is one example: its slug and metadata remain
external data even when a local row refers to them.

## Core Rule

Validate external data at the boundary where it becomes domain data. When an
individual external entity cannot be recognized or validated, treat that
entity as absent or unavailable. It must not turn an otherwise valid list,
read, or execution into an internal server error.

- A collection consumer skips the invalid item and continues with valid items.
- A direct lookup returns the domain's normal missing or unsupported result.
- An optional runtime dependency proceeds without that entity when the product
  contract permits it.
- Persisted references to a removed external entity use the same unavailable
  behavior; storing the value locally does not make its external owner stable.

Do not silently substitute a different identity. If a specific external entity
is invalid, it is unavailable; it is not permission to select another entity
unless the product has an explicit preference/default rule.

## Security Must Fail Closed

Invalid external data must never grant capabilities, credentials, targets, or
ownership. Validate identity and authorization before using an external item.
If validation fails, exclude it from the authorized set and continue only with
already-authorized behavior.

For example, an unknown connector catalog entry may be ignored, but it must not
be converted into a custom connector, mapped to a similarly named connector,
or allowed to expand an agent's connector scope.

## What Should Still Fail

This principle is not a broad error-recovery rule. Let internal failures and
violated local invariants propagate:

- database connectivity and transaction failures;
- impossible states protected by local schema constraints;
- programmer errors and broken internal contracts;
- failure of a required external operation where the product cannot proceed.

Do not wrap a whole route or workflow in `try/catch` and call every exception
"missing external data." Parse the external value explicitly, branch on the
validation result, and allow unrelated exceptions to surface normally.

## Implementation Pattern

Prefer parsers that return a result at the trust boundary. Normalize valid data
once, then let the rest of the code use the validated type.

```typescript
const parsed = externalItemSchema.safeParse(value);
if (!parsed.success) {
  return undefined;
}
return parsed.data;
```

For collections, validate per item rather than rejecting the entire collection
because one external record is bad. Preserve enough structured observability to
identify the provider and validation category, but never log credentials,
tokens, or raw sensitive payloads.

## Testing

Cover this behavior at a real entry point with real infrastructure:

- seed or return an unknown, removed, or malformed external entity;
- verify the request does not become a 500 solely because of that entity;
- verify valid sibling entities still work;
- verify the invalid entity grants no capability or credential;
- verify a direct lookup reports the normal unavailable result.

Use an integration test at the API, CLI, or runtime boundary. Do not replace it
with a unit test of the schema parser.

## Relationship to Fallbacks

Treating genuinely optional or externally owned data as unavailable is a
permanent domain rule, not rolling-deployment compatibility. Document it in a
PR's `Fallbacks` section when a change introduces such a path, as required by
[Fallbacks to avoid](./fallback.md). Do not use this principle to preserve
obsolete internal formats or hide migration defects.
