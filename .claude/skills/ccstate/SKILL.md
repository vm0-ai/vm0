---
name: ccstate
description: Patterns and best practices for using ccstate state management in the vm0 platform
---

# ccstate Patterns and Best Practices

This document records common patterns and best practices when using ccstate in the vm0 platform.

## DOM Callback Pattern

When handling DOM events (like button clicks) that trigger async commands, follow this pattern:

### Problem

DOM event handlers that call async commands will trigger TypeScript lint error `@typescript-eslint/no-floating-promises`.

### Solution

Use the `detach()` function with `Reason.DomCallback` to explicitly mark the promise as intentionally fire-and-forget.

### Pattern

```typescript
import { useSet, useGet } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { someCommand$ } from "../../signals/some-command.ts";

function MyComponent() {
  const commandFn = useSet(someCommand$);
  const pageSignal = useGet(pageSignal$);

  const handleClick = () => {
    detach(commandFn(pageSignal), Reason.DomCallback);
  };

  return <button onClick={handleClick}>Click me</button>;
}
```

### Key Points

0. This pattern only applies to React views — it is forbidden to use in the signals directory
1. **Always use `pageSignal$`**: Get the page signal using `useGet(pageSignal$)` instead of creating a new `AbortController`
2. **Use `detach()` instead of `void`**: The `detach()` function properly handles promise rejection and tracks the promise for testing
3. **Use `Reason.DomCallback`**: This enum value indicates the promise is from a DOM event handler
4. **Never use `void` operator**: Using `void` silences the lint error but doesn't properly handle the promise

## Related Patterns

### Getting pageSignal$ in Components

```typescript
import { useGet } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";

function MyComponent() {
  const pageSignal = useGet(pageSignal$);
  // Use pageSignal to call commands
}
```

### pageSignal$ is Automatically Set by Route System

**Important**: You do NOT need to manually set `pageSignal$` in your setup commands. The route system automatically handles this through `setupPageWrapper`.

```typescript
// ✅ Correct: setupPageWrapper automatically sets pageSignal$
export const setupLogsPage$ = command(({ set }, signal: AbortSignal) => {
  // NO need to call set(setPageSignal$, signal) - it's automatic!

  // Just do your page-specific initialization
  set(initLogs$, signal);
  set(updatePage$, createElement(LogsPage));
});

// In bootstrap.ts, routes use setupAuthPageWrapper which calls setupPageWrapper:
const ROUTE_CONFIG = [
  {
    path: "/logs",
    setup: setupAuthPageWrapper(setupLogsPage$), // Wrapper sets pageSignal$ automatically
  },
];
```

**How it works**:

1. Route navigation triggers `loadRoute$` (in route.ts)
2. `loadRoute$` calls `setupAuthPageWrapper(setupLogsPage$)`
3. `setupAuthPageWrapper` internally calls `setupPageWrapper`
4. `setupPageWrapper` sets `pageSignal$` before calling your setup command
5. Your setup command receives the signal and can access `pageSignal$` in components

**Never manually set pageSignal$ in setup commands** — the wrapper does it for you.

## Reactive Async Computed vs Imperative Fetch Commands

Prefer reactive `computed(async ...)` over imperative fetch-and-store commands.

### Anti-pattern: Imperative fetch command with manual state

```typescript
// ❌ Requires explicit calls from every page setup, manual loading/error tracking
const agentsState$ = state({ agents: [], loading: false, error: null });
export const agentsList$ = computed((get) => get(agentsState$).agents);
export const agentsLoading$ = computed((get) => get(agentsState$).loading);

export const fetchAgentsList$ = command(async ({ get, set }, signal) => {
  set(agentsState$, (prev) => ({ ...prev, loading: true }));
  try {
    const result = await get(zeroClient$)(contract).list();
    set(agentsState$, { agents: result.body, loading: false, error: null });
  } catch (error) {
    set(agentsState$, (prev) => ({
      ...prev,
      loading: false,
      error: error.message,
    }));
  }
});
```

### Preferred: Reactive async computed

```typescript
// ✅ Auto-fetches on first access, invalidates via counter bump
const internalReload$ = state(0);
export const agents$ = computed(async (get) => {
  get(internalReload$);
  const result = get(zeroClient$)(contract).list();
  if (result.status !== 200) throw new Error(`Failed (${result.status})`);
  return result.body;
});
export const reloadAgents$ = command(({ set }) => {
  set(internalReload$, (prev) => prev + 1);
});
```

**Benefits:**

- No manual loading/error state — consumers use `useLoadable()` or `useLastResolved()` from ccstate-react
- No explicit fetch calls in page setups — data loads lazily when first accessed
- Invalidation via `reloadAgents$` is a simple counter bump
- Fewer files touched, fewer places to forget the fetch call

**Consumer patterns in views:**

```typescript
// Loading/error from loadable state
const agentsLoadable = useLoadable(agents$);
const loading = agentsLoadable.state === "loading";
const error =
  agentsLoadable.state === "hasError" ? agentsLoadable.error.message : null;

// Last resolved value (keeps showing old data while reloading)
const agents = useLastResolved(agents$) ?? [];
```

## AbortSignal Lifecycle and Ownership

**Every AbortSignal must have a clear owner that will abort it.** Orphaned signals cause polling loops that never stop and promises that leak past test boundaries.

### Signal hierarchy

```
rootSignal$ (app lifecycle)
  └── routeSignal (per-route, aborted on navigation)
      └── pageSignal$ (exposed to components)
          └── resetSignal() (per-operation, e.g. send/polling)
```

### Two usage patterns of `resetSignal()`

`resetSignal()` creates an independent `AbortController` and aborts the previous one on each call. It has two normal usage patterns:

1. **With parent signal**: The signal is controlled by both the parent lifecycle and the next reset
2. **Without parent signal**: The signal is controlled only by the next reset (mutual exclusion) or explicit cancellation

**How `resetSignal` works:**

```typescript
// From utils.ts
return command(({ get, set }, ...signals: AbortSignal[]) => {
  get(controller$)?.abort(); // abort previous
  const controller = new AbortController();
  set(controller$, controller);
  return AbortSignal.any([controller.signal, ...signals]); // combine with parents
});
```

The core capability of `resetSignal` is **mutual exclusion**: each call aborts the previous signal. This naturally provides two abort paths:

- **Starting the next task** automatically cancels the previous one (mutual exclusion)
- **Calling without data** (i.e., not starting a new task) simply cancels the current one

#### Pattern 1: With parent signal — participating in lifecycle

When the operation needs to be aborted along with the page/route lifecycle, pass in a parent signal:

```typescript
// Signal aborts on any of: page navigation, next reset
const signal = set(resetSending$, pageSignal);
```

#### Pattern 2: Without parent signal — pure cancellation control

When the operation does not need to be tied to the page lifecycle and only needs mutual exclusion and explicit cancellation, omit the parent:

**Example 1: Cancel button for file upload** (`chat-draft.ts`)

```typescript
function createChatAttachment(file: File): ZeroChatAttachment {
  const resetSignal$ = resetSignal();

  // Explicit cancel: no new task started, just abort the current upload
  const cancel$ = command(({ set }) => {
    set(resetSignal$);
  });

  // Mutual exclusion start: starting a new upload auto-cancels the previous, also binds to page lifecycle
  const upload$ = command(async ({ get, set }, signal: AbortSignal) => {
    const uploadSignal = set(resetSignal$, signal);
    // ... use uploadSignal for the upload ...
  });
}
```

`cancel$` omits the parent — its job is to abort the current upload when there is no next upload to start. `upload$` passes the parent because page unmount should also abort the upload.

**Example 2: Message sending across page navigation** (`zero-chat.ts`)

```typescript
/**
 * The talk page navigates from /agents/:id/chat to /chats/:id on send,
 * which aborts the page-level signal. This dedicated signal lets the
 * talk page pass a cancellable AbortSignal without coupling to the page
 * lifecycle.
 */
export const resetTalkSendSignal$ = resetSignal();

// Mutual exclusion: each new message send cancels the previous one
export const startNewZeroSession$ = command(({ get, set }) => {
  set(resetTalkSendSignal$);
  set(internalLocalMessages$, []);
  set(get(talkDraft$).clear$);
});
```

Getting the independent signal in the view layer:

```typescript
const handleSendMessage = (message: string) => {
  startNewSession(); // internally calls set(resetTalkSendSignal$), cancels previous
  const talkSignal = resetTalkSendSignal(); // get a fresh independent signal
  detach(
    sendNewThread(resolvedAgentId, message, talkSignal),
    Reason.DomCallback,
  );
};
```

The parent is omitted here because the send operation needs to survive page navigation — if bound to `pageSignal$`, the route change would abort the in-flight send request.

### Common mistake: floating polling loop

For **long-running operations** (like polling loops), a parent signal is required, otherwise the loop never stops (mutual exclusion only takes effect on the next call — if there is no next call, the loop leaks):

```typescript
// ❌ resumeSignal has no parent — loop runs forever if resetSending$ isn't called again
const resumeSignal = set(resetSending$);
set(startLoop$, { runId }, resumeSignal);

// ✅ Pass the page/route signal so loop stops on navigation
const resumeSignal = set(resetSending$, signal);
set(startLoop$, { runId }, resumeSignal);
```

## Detach, Floating Promises, and Test Cleanup

### Scope of `detach()` usage

**`detach()` should only appear in the views layer (React components), not in the signals directory.**

`detach` with `Reason.DomCallback` is designed for DOM event handlers — in React components, event callbacks cannot return a promise, so `detach` is needed to track the fire-and-forget promise.

In the signals layer, the caller can always `await` the return value or manage the lifecycle through the signal chain. If you find yourself needing `detach` in signals, it usually means the signal chain or command composition is flawed — fix the root cause instead of working around it with `detach`.

```typescript
// ✅ Views layer: use detach in DOM event callbacks
const handleClick = () => {
  detach(commandFn(pageSignal), Reason.DomCallback);
};

// ❌ Signals layer: detach should not appear here, use await or signal chain
export const someCommand$ = command(async ({ set }, signal) => {
  detach(set(anotherCommand$, signal), Reason.Daemon); // ← misuse
});

// ✅ Signals layer: correct approach is to await directly
export const someCommand$ = command(async ({ set }, signal) => {
  await set(anotherCommand$, signal);
});
```

### `detach()` tracks promises for cleanup

```typescript
detach(someAsyncWork(), Reason.DomCallback);
```

- `clearAllDetached()` in `afterEach` awaits all tracked promises
- Without `detach`, a fire-and-forget promise is a **floating promise** — invisible to cleanup

### Floating promises are dangerous

```typescript
// ❌ Floating promise — escapes all cleanup, causes DOMException on teardown
set(startLoop$, { runId }, signal).catch((e) => { ... });

// ✅ Tracked by detach in the views layer — clearAllDetached will await it
detach(set(startLoop$, { runId }, signal), Reason.Daemon);
```

But don't use `detach` to paper over orphaned signals. Fix the signal chain first.

### Test cleanup order matters

```typescript
// ✅ Correct: abort detached promises BEFORE removing MSW handlers
afterEach(async () => {
  await clearAllDetached(); // 1. abort & await all detached promises
  server.resetHandlers(); // 2. then remove mock handlers
});

// ❌ Wrong: promises try to fetch after handlers are gone → ECONNREFUSED / 401
afterEach(() => {
  server.resetHandlers(); // handlers gone
  // detached promises still running, hit real network
});
```

## Extracting Shared Logic from Commands

When two or more commands share duplicated logic, extract it into a **sub-command** (`command()`), not a plain function that receives `get`/`set`.

### Why not a plain function?

A plain helper that accepts `get` or `set` as parameters breaks the ccstate contract — `get`/`set` are scoped to the command callback and should not leak out. The ESLint rule `ccstate/...` flags this. More importantly, a plain function cannot participate in the signal/reactive graph.

### Pattern: Extract a sub-command

```typescript
// ❌ Plain function receiving get — breaks ccstate contract
async function sendRequest(
  get: Getter,
  agentId: string,
  prompt: string,
): Promise<Result> {
  const client = get(zeroClient$)(contract);
  return await client.send({ body: { agentId, prompt } });
}

// ✅ Sub-command — get/set stay inside the command callback
const sendRequest$ = command(
  async ({ get }, agentId: string, prompt: string): Promise<Result> => {
    const client = get(zeroClient$)(contract);
    return await client.send({ body: { agentId, prompt } });
  },
);

// Caller
const doSomething$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await set(sendRequest$, agentId, prompt);
  signal.throwIfAborted();
  // ...
});
```

### Handling AbortSignal in sub-commands

**Pass `signal` explicitly and use `fetchOptions: { signal }` for HTTP calls.** This ensures the request is cancelled when the caller's signal aborts.

```typescript
const sendRequest$ = command(
  async (
    { get },
    agentId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Result> => {
    const client = get(zeroClient$)(contract);
    const result = await client.send({
      body: { agentId, prompt },
      fetchOptions: { signal }, // ← cancel HTTP on abort
    });

    if (result.status !== 201) {
      throw new Error(`Failed (${result.status})`);
    }
    return result.body;
  },
);
```

The caller passes its own signal through:

```typescript
const parentCommand$ = command(async ({ set }, signal: AbortSignal) => {
  const result = await set(sendRequest$, agentId, prompt, signal);
  // No need for signal.throwIfAborted() here — if signal was aborted,
  // the fetch inside sendRequest$ already threw an AbortError.
  // Only add throwIfAborted() after operations that DON'T accept a signal.
});
```

### When to use `signal.throwIfAborted()`

Use it **after any `await` that does NOT accept a signal** — i.e., after operations that will complete even if the caller wants to abort:

```typescript
const example$ = command(async ({ get, set }, signal: AbortSignal) => {
  // ✅ fetch accepts signal → no throwIfAborted needed after
  const result = await set(sendRequest$, data, signal);

  // ✅ get() on a computed is synchronous-ish but doesn't accept signal
  const thread = await get(currentThread$);
  signal.throwIfAborted(); // ← needed: get() doesn't know about our signal

  // ✅ set() on a sub-command that passes signal through → no throwIfAborted needed
  await set(anotherCommand$, thread.id, signal);
});
```

**Rule of thumb:** If the awaited operation receives your signal, it will throw on abort itself. If it doesn't, check manually after.
