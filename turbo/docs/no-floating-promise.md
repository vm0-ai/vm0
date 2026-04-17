# No Floating Promises

This document explains common patterns for handling async operations in the codebase, particularly when dealing with long-running loops like Ably subscriptions.

## The Problem

When starting async operations that run indefinitely (like event subscription loops), we need to handle their promises properly. The `@typescript-eslint/no-floating-promises` lint rule catches cases where promises are not awaited or handled.

## Wrong Patterns

### Pattern 1: Fire-and-forget with `void`

```typescript
// WRONG: Creates unhandled rejections when signal aborts
void set(setAblyLoop$, topic, callback$, signal);
```

This pattern:

- Silences the lint error but doesn't actually handle rejections
- When the signal aborts, the loop throws `AbortError`
- The rejection becomes an unhandled promise rejection
- Pollutes test output with "Unhandled Rejection" errors

### Pattern 2: Fire-and-forget with `.catch(throwIfNotAbort)`

```typescript
// WRONG: Still creates floating promises, swallows errors inconsistently
void set(setAblyLoop$, topic, callback$, signal).catch(throwIfNotAbort);
```

This pattern:

- Swallows `AbortError` but the promise is still "floating"
- The calling function loses track of the async operation
- Makes cleanup and error propagation unclear

### Pattern 3: `await` inside `Promise.all` array

```typescript
// WRONG: Sequential execution, not parallel
await Promise.all([
  set(loopA$, signal),
  await set(loopB$, signal), // BUG: await here blocks
  await set(loopC$, signal), // Never reached if loopB$ hangs
]);
```

This pattern:

- JavaScript evaluates array elements sequentially before passing to `Promise.all`
- The `await` inside the array causes loopB$ to block, loopC$ never starts
- If loopB$ never resolves, the function hangs

## Correct Pattern

### Use `await Promise.all([...])` without inner awaits

```typescript
// CORRECT: All loops start in parallel, rejections propagate to caller
await Promise.all([
  set(setAblyLoop$, topicA, callbackA$, signal),
  set(setAblyLoop$, topicB, callbackB$, signal),
  set(setAblyLoop$, topicC, callbackC$, signal),
]);
```

This pattern:

- All three loops start concurrently
- When the signal aborts, all loops throw `AbortError`
- `Promise.all` rejects with the first error
- The rejection propagates up to the caller
- The caller is responsible for handling the abort (usually via `signal.throwIfAborted()`)
- No floating promises, no unhandled rejections

### Why this works for infinite loops

For loops that run until abort (like Ably subscriptions):

1. `setAblyLoop$` enters an infinite `while (!signal.aborted)` loop
2. `Promise.all` waits for all three promises
3. When signal aborts, `signal.throwIfAborted()` inside each loop throws
4. All three promises reject with `AbortError`
5. `Promise.all` rejects, propagating the error to the caller
6. The caller's abort handling (or test cleanup) catches the error

### Example in context

```typescript
const loadPagedMessages$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const thread = await get(threadData$);
    signal.throwIfAborted();

    // ... setup callbacks ...

    // Start all subscription loops in parallel
    await Promise.all([
      set(
        setAblyLoop$,
        `chatThreadMessageCreated:${threadId}`,
        onMessageCreated$,
        signal,
      ),
      set(
        setAblyLoop$,
        `chatThreadRunCreated:${thread.id}`,
        onRunChanged$,
        signal,
      ),
      set(
        setAblyLoop$,
        `chatThreadRunUpdated:${thread.id}`,
        onRunChanged$,
        signal,
      ),
    ]);

    // This line is only reached if all loops complete (return true)
    // or never reached if signal aborts (Promise.all rejects)
    signal.throwIfAborted();
  },
);
```

## Summary

| Pattern                              | Lint passes | Handles abort | Clean test output |
| ------------------------------------ | ----------- | ------------- | ----------------- |
| `void set(...)`                      | Yes         | No            | No                |
| `void set(...).catch(...)`           | Yes         | Partial       | No                |
| `await set(...)` inside array        | Yes         | No (hangs)    | N/A               |
| `await Promise.all([set(...), ...])` | Yes         | Yes           | Yes               |

Always use `await Promise.all([...])` for starting multiple long-running async operations.
