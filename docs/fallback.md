# Fallbacks to Avoid

A fallback is any extra code path that handles a state the current system is
not supposed to produce: a `??` chain on a field the contract makes required,
a branch for a retired protocol, a default that hides a corrupted row, or a
test that asserts deleted behavior is still deleted.

The default in this repository is **no fallback**. `docs/bad-smell.md` states
the fail-fast rule for configuration; this document extends it to protocols,
persisted state, feature rollout, and tests, and lists the narrow cases where
a fallback is required.

Every fallback costs the same three things: an extra code path that nobody
executes on purpose, an extra state that every future reader must reason
about, and a silent failure mode that turns a loud bug into wrong behavior.
A fallback is worth that cost only when a real, currently-reachable state
needs it.

## 1. Do Not Write Negative Tests Against Old Code

A negative test asserts that removed behavior stays removed: the retired route
still 404s, the legacy field is still ignored, the old parser still rejects the
old shape. These are tombstones. They do not protect a user-visible behavior;
they pin the absence of code that no longer exists.

```typescript
// ❌ Bad: tombstone tests for behavior that was deleted
it("returns 404 for retired BB0, API key, and public v1 routes", async () => {
  /* ... */
});
it("does not expose the legacy computer-use command approval route", async () => {
  /* ... */
});
it("does not read legacy vm0 preview bypass query params", () => {
  /* ... */
});
```

**Why they are harmful:**

- They never fail for a real reason. The route table and the type system
  already prove the code is gone; the test only re-states the deletion.
- They accumulate. Every cleanup adds another tombstone, and the suite grows
  in the one direction that produces no coverage.
- They block the next change. Reusing a path, a field name, or an error code
  now requires deleting a test that looks like a deliberate guard.
- They cost CI time on every run, forever.

**Delete the old test together with the old code.** When a behavior is
replaced, update the existing test to the new behavior instead of keeping the
old assertion alongside it. PR #22573 removed roughly forty such tombstones in
one pass; that entire class of test should never have been written.

**The narrow exception** is a fail-closed security boundary, where the
assertion is that an attacker-supplied legacy credential, token prefix, or
signature format is rejected. There the negative outcome _is_ the product
behavior, and the test stays. "Old code is gone" is not a security boundary.

## 2. Features Behind a Feature Switch Need No Fallback

A feature that has not reached full rollout has no external users. While it is
gated by a `FeatureSwitchKey` that is off by default or staff-only, do not
write compatibility code for it:

- no dual-read or dual-write between the old and new shape,
- no tolerance branch for data written by the previous iteration of the
  feature,
- no client-side handling for an API response the deployed API no longer
  returns,
- no migration or backfill for rows only staff produced.

**A temporary 500 or a broken screen during the cutover is acceptable.** The
blast radius is the staff org that opted in, and the recovery is a refresh or
a redeploy. Paying for a fallback here buys nothing and slows every subsequent
iteration, because each iteration then has to carry, test, and later remove
that fallback.

```typescript
// ❌ Bad: compatibility branch for a pre-GA feature's own earlier shape
const layout = parseLayout(row.layout) ?? parseLegacyStaffLayout(row.layout);

// ✅ Good: one shape, fail loudly if a stale staff row shows up
const layout = parseLayout(row.layout);
```

**Where this stops applying:** once the switch is `enabled: true` for everyone,
the feature is GA and the normal rules in `docs/deployment-compatibility.md`
apply in full. The boundary is the rollout state of the switch, not the age of
the code.

Removing the switch itself is a separate cleanup: when a switch is terminal,
delete the switch, the disabled branch, and the tests for the disabled branch
together.

## 3. Do Not Fall Back On States the Contract Cannot Produce

Most fallback slop is a `??` or `||` chain guarding a value that the owning
contract already guarantees. The chain does not add safety; it invents an
identity that no caller ever asked for.

```typescript
// ❌ Bad: `name` is required by the SDK type; the chain silently changes the
// cached identity to an unrelated field
const displayName = org.name ?? org.slug ?? org.id;

// ✅ Good: use the field the contract guarantees
const displayName = org.name;
```

The same rule covers:

- `?? 0` on a metric that is initialized and updated as a required number,
- a final `?? null` on a value derived from a `NOT NULL` column,
- a fabricated React key for a state the component never constructs,
- `as unknown as` bridges that reconnect types the fallback broke.

Before deleting one, confirm the state is genuinely unreachable under the
owning contract — the SDK type, the Zod schema, the DB nullability, or the
single writer that produces the row. Record that evidence in the PR.

## 4. Do Not Fabricate Data For Corrupted Persisted State

When a required column is null but the only writer always sets it, the row is
corrupted. Deriving a plausible value from an ID or a filename hides an
impossible database state and produces a wrong answer instead of an alert.

```typescript
// ❌ Bad: rebuild metadata from the asset ID when the row is incomplete
const contentType = row.contentType ?? guessMimeFromUuid(row.id);
const status = row.status ?? "failed";

// ✅ Good: throw a precise invariant error
if (!row.contentType) {
  throw new Error(`slack-input asset ${row.id} is missing contentType`);
}
```

Genuinely optional columns keep their documented default. The test is whether
the writer can legitimately leave the field unset, not whether the type happens
to be nullable.

## 5. Do Not Keep Fallbacks For Retired Protocols and Layouts

Once a producer is gone, its reader is dead weight. Delete the reader in the
same PR that retires the producer, or in an explicit follow-up PR that names
the rollout window it waited for.

This includes retired runner event shapes, superseded API routes, old storage
prefixes, previous OAuth callback metadata, obsolete IndexedDB cache versions,
and unordered heartbeat senders that no live runner can still emit. When old
rows in the retired shape still exist, delete or migrate them rather than
teaching the reader to accept both.

## 6. Fallbacks That Are Required

Keep a fallback only when it belongs to one of these:

1. **Time-boxed cross-version rollout compatibility.** Frontend, backend, and
   runner deploy independently, so a briefly-mixed fleet is a real reachable
   state. See `docs/deployment-compatibility.md`. This fallback must be
   time-boxed (see section 7).
2. **Genuinely optional external data.** Third-party API fields that the
   provider documents as optional, or that runtime inspection proves absent
   despite the TypeScript declaration.
3. **Genuinely nullable persisted columns**, where a legitimate writer leaves
   the field unset.
4. **Presentational defaults** with no identity meaning — placeholder artwork
   for an unavailable preview, an empty-state label.

Everything else is slop.

## 7. Writing a Time-Boxed Rollout Fallback

A legitimate rollout fallback is introduced with its removal already planned.

**Step 1 — ship the tolerant version with a comment stating the removal
condition.** PR #25563 added an additive route and let the app accept the old
API's `404`:

```typescript
const result = await accept(client.unreadIds(), [200, 404]);
// A newly promoted app can briefly reach an API version from before this
// additive route existed. Remove after that API is outside the production
// rollback window.
return new Set(result.status === 200 ? result.body.threadIds : []);
```

**Step 2 — after the rollback window closes, remove the fallback, the contract
entry, and its test.** PR #25694 did exactly that:

```typescript
const result = await accept(client.unreadIds(), [200]);
return new Set(result.body.threadIds);
```

The follow-up PR removed the `404` from the contract, narrowed the BDD helper's
status type, and deleted the test that exercised the missing route. Note that
the deleted test is not a regression loss: it covered the temporary fallback,
so it dies with the fallback rather than becoming a tombstone.

Requirements for this pattern:

- a comment naming the condition that makes the branch removable,
- a follow-up issue or PR that removes it,
- the removal deletes the tolerant branch, the contract entry, the helper
  types, and the fallback's tests together.

An "old shape tolerated forever" branch with no removal condition is not a
rollout fallback; it is section 5 slop.

## 8. Evidence Required When Removing a Fallback

Removing a fallback is a behavior change until proven otherwise. A cleanup PR
must show why the removed branch is unreachable:

- **Type or schema evidence** — the field is required by the SDK type, the Zod
  schema, or a `NOT NULL` column.
- **Single-writer evidence** — the only code path that creates the row always
  sets the field.
- **Production evidence** — a read-only query against the masked production
  branch showing zero rows in the old shape. PR #24888 removed an unreachable
  claim-time fallback only after confirming `pending_automation = 0`.
- **Rollout evidence** — the deploy that made the old version unreachable is
  past its rollback window.

State which of these applies for each removed branch, and keep the invariant
throw so monitoring surfaces a violation if the assumption ever breaks.

## Review Checklist

- Does the PR add a fallback for a state the contract, schema, or single
  writer already prevents? Request removal.
- Is the feature still behind a non-GA feature switch? Then no compatibility
  code, no migration, no dual-read is required, and a transient error during
  cutover is acceptable.
- Does the PR add a test that asserts removed behavior stays removed? Request
  removal unless it is a fail-closed security boundary.
- Does a new rollout fallback carry a removal condition and a follow-up?
- Does a removal PR carry type, single-writer, production, or rollout evidence?
- Does the removal delete the branch, the contract entry, and the branch's own
  tests together?
