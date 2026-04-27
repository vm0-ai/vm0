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

## Computed Memoization — No Manual Cache Needed

ccstate `computed` automatically memoizes the last result. If none of the dependencies have changed, reading the computed returns the cached value without re-executing the callback. **Do not add a manual `Map` or cache layer on top.**

```typescript
// ❌ Redundant cache — computed already memoizes
const cache = new Map<string, Result>();
export const result$ = computed((get) => {
  const key = get(someKey$);
  if (cache.has(key)) return cache.get(key)!;
  const value = expensiveCreate(key);
  cache.set(key, value);
  return value;
});

// ✅ Just create — computed won't re-run if someKey$ hasn't changed
export const result$ = computed((get) => {
  const key = get(someKey$);
  return expensiveCreate(key);
});
```

This is especially relevant for signal factories: a `computed` that calls `createSomeSignals(id)` won't re-create the signals unless `id` actually changes.

## Storing Function Values in State — The Updater Gotcha

When you call `set(atom$, value)`, ccstate checks if `value` is a function. If it is, ccstate treats it as an **updater** — it calls `value(previousValue)` and stores the **return value**, not the function itself. This is the same convention as React's `setState(fn)`.

This means **you cannot directly store a function in a `state()` atom using `set()`**. The function will be executed immediately instead of stored.

### The problem

```typescript
const cleanup$ = state<(() => void) | null>(null);

// ❌ BUG: ccstate calls the arrow function as an updater
// It executes: (() => { reader.cancel(); audioCtx.close(); })(previousValue)
// The return value (undefined) is stored, and the side effects fire immediately
set(cleanup$, () => {
  reader.cancel();
  audioCtx.close();
});
```

This is especially dangerous because:
1. The side effects (cancel, close) execute **immediately** instead of being deferred
2. The stored value becomes `undefined` (the return value of the arrow function), not the function
3. There is no runtime error at the `set()` call site — the bug is silent

### The fix: wrap in an updater that returns the function

```typescript
const cleanup$ = state<(() => void) | null>(null);

// ✅ Outer arrow is the updater; it returns the cleanup function to store
const cleanupFn = () => {
  reader.cancel();
  audioCtx.close();
};
set(cleanup$, () => cleanupFn);
```

The outer `() => cleanupFn` is called as the updater — it receives `previousValue` (ignored) and returns `cleanupFn`, which is then stored in the atom.

### Why this happens

From ccstate's core (`ccstate/core/index.js`):

```javascript
if (typeof val === 'function') {
  var updater = val;
  newValue = updater(previousValue);
} else {
  newValue = val;
}
```

This is by design — it mirrors React's `useState` updater pattern:

```typescript
// React: setState(prev => prev + 1) — function is an updater, not the value
// ccstate: set(count$, prev => prev + 1) — same convention
```

### When to watch out

Any time a `state()` atom holds a function type:
- `state<(() => void) | null>(null)` — cleanup callbacks
- `state<(arg: T) => R>(defaultFn)` — configurable handlers
- `state<Function | null>(null)` — generic function storage

In all these cases, use the updater wrapper: `set(atom$, () => theFn)`.

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
  const result = await accept(
    get(zeroClient$)(contract).list(),
    [200],
    { toast: false }, // background fetch — no toast, let useLoadable show error state
  );
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

## HTTP Error Handling with `accept`

All HTTP calls via `zeroClient$` must use the `accept` utility function. This is the **only** permitted way to handle API response status codes. Manual status checks, try-catch for HTTP errors, and direct `toast.error` calls for API failures are all forbidden in the signals layer.

### Core Pattern

`accept` takes a ts-rest call promise, a **required non-empty** array of accepted status codes, and an optional options object. It returns a type-narrowed result containing only the accepted status codes. Any response **not** in the accept list is automatically:

1. Shown as a `toast.error` (with the server's error message)
2. Thrown as an `ApiError` (so the calling code stops executing)

```typescript
import { accept } from "../../lib/accept.ts";

// Signal: clean business logic, no manual error handling
export const inviteMember$ = command(
  async ({ get, set }, email: string, role: OrgRole, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroOrgInviteContract);
    const result = await accept(
      client.invite({ body: { email, role } }),
      [200],
    );
    // result type is narrowed to { status: 200, body: OrgMessageResponse }
    // If status was 400/401/403/500 → toast + throw already happened, we never reach here
    toast.success(`Invitation sent to ${email}`);
    set(refreshOrgMembers$);
  },
);
```

### accept is required — `accept` list must be explicit

Every `zeroClient$` call must be wrapped in `accept`. You must declare at least one status code. This forces every call site to explicitly state what it considers success.

```typescript
// ❌ Forbidden: raw status checks
const result = await client.invite({ body });
if (result.status !== 200) {
  throw new Error("Failed");
}

// ❌ Forbidden: try-catch for HTTP errors in signals
try {
  await client.invite({ body });
} catch (error) {
  toast.error("Failed");
}

// ✅ Required: use accept
const result = await accept(client.invite({ body }), [200]);
```

### Handling specific error codes (e.g. 404 → return null)

When a specific error code has business meaning, include it in the accept list:

```typescript
export const getAgent$ = computed(async (get) => {
  const client = get(zeroClient$)(zeroAgentsByIdContract);
  const result = await accept(client.get({ params: { id } }), [200, 404], {
    toast: false,
  });
  if (result.status === 404) return null;
  return result.body;
});
```

### Suppress toast for background fetches

For `computed` (background data fetching), pass `{ toast: false }` so errors are silent — the view layer uses `useLoadable` to render the error state instead:

```typescript
export const billingStatus$ = computed(async (get) => {
  const client = get(zeroClient$)(zeroBillingStatusContract);
  const result = await accept(client.get(), [200], { toast: false });
  return result.body;
});
```

### View layer: use `useLoadableSet` for error display

When `accept` throws, `useLoadableSet` transitions to `{ state: 'hasError', error: ApiError }`. Views should use this state for inline error rendering — **never catch errors in the view layer for toast purposes** (accept already toasted).

```typescript
function ScheduleForm() {
  const [loadable, save] = useLoadableSet(saveSchedule$);

  return (
    <>
      <Button
        disabled={loadable.state === "loading"}
        onClick={() => detach(save(params, pageSignal), Reason.DomCallback)}
      >
        Save
      </Button>
      {loadable.state === "hasError" && (
        <ErrorMessage>{loadable.error.message}</ErrorMessage>
      )}
    </>
  );
}
```

For cases that need inline error display **without** toast, the signal uses `{ toast: false }` in `accept`, and the view reads `hasError`:

```typescript
// signal
export const saveSchedule$ = command(async ({ get, set }, params, signal) => {
  const client = get(zeroClient$)(contract);
  const result = await accept(
    client.deploy({ body: params }),
    [200, 201],
    { toast: false }, // suppress toast — view will show inline error
  );
  toast.success("Schedule saved");
});

// view: hasError shows inline error, no toast duplication
```

### Summary of rules

1. **All `zeroClient$` calls must use `accept`** — no exceptions
2. **`accept` list is required and non-empty** — you must declare at least one status code
3. **No manual `throw` / `try-catch` for HTTP errors in signals** — `accept` handles it
4. **Toast is on by default** — pass `{ toast: false }` to suppress (background fetches, inline error display)
5. **View layer uses `useLoadableSet` hasError** for inline error rendering — never `.catch()` for toast

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

### Never use `.catch(() => {})` to silence floating promises

**Enforced by ESLint rule: `ccstate/no-empty-promise-catch`**

`.catch(() => {})` technically satisfies `@typescript-eslint/no-floating-promises` (the promise is "handled"), but the empty handler means the promise is invisible to `clearAllDetached()` — it escapes test cleanup and can cause DOMException on teardown.

```typescript
// ❌ Silences lint but escapes cleanup — caught by no-empty-promise-catch
loadFile(file, signal).catch(() => {});
handleToggle(entry, enabled).catch(() => {});

// ✅ Properly tracked for cleanup
detach(loadFile(file, signal), Reason.DomCallback);
detach(handleToggle(entry, enabled), Reason.DomCallback);
```

If the promise has a `.then()` chain before it, wrap the entire chain:

```typescript
// ❌ Empty catch at the end
saveData(signal)
  .then(() => {
    toast.success("Saved");
  })
  .catch(() => {});

// ✅ Wrap entire chain in detach
detach(
  saveData(signal).then(() => {
    toast.success("Saved");
  }),
  Reason.DomCallback,
);
```

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
    const result = await accept(
      client.send({
        body: { agentId, prompt },
        fetchOptions: { signal },
      }),
      [201],
    );
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

## DOM Ref Pattern — `onRef`

When a signal stores a reference to a DOM element (e.g., a scroll container, a file input), **always use `onRef`** to wrap the setter command. Never write a command that directly accepts `HTMLElement | null`.

### Why

React ref callbacks receive `null` when the element unmounts. A plain command that accepts `el | null` has no lifecycle hook — there is no place to remove event listeners or cancel side-effects tied to the element. `onRef` solves this by:

1. Filtering out `null` — the inner command only fires when the element mounts.
2. Providing an `AbortSignal` — aborted automatically when the element unmounts, so cleanup is trivial.
3. Returning a React-compatible cleanup function for ref callbacks (React 19+).

### Pattern

```typescript
import { command, state, computed } from "ccstate";
import { onRef } from "../utils.ts";

const internalEl$ = state<HTMLElement | null>(null);

export const el$ = computed((get) => get(internalEl$));

export const setEl$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalEl$, null);
    });
    set(internalEl$, el);
  }),
);
```

The resulting type is `Command<(() => void) | undefined, [HTMLElement | null]>` — it accepts `null` (for React ref callbacks) and returns a cleanup function when non-null.

### Anti-pattern

```typescript
// ❌ WRONG — no lifecycle, no cleanup mechanism
const setEl$ = command(({ set }, el: HTMLElement | null) => {
  set(internalEl$, el);
});
```

### View usage

Pass the `useSet` result directly as a ref — do **not** wrap it in an arrow function (which would discard the cleanup return value):

```typescript
// ✅ Correct
const setEl = useSet(setEl$);
return <div ref={setEl} />;

// ❌ Wrong — discards cleanup
return <div ref={(el) => { setEl(el); }} />;
```

### In factory interfaces

Use the `onRef` return type in the interface:

```typescript
export interface MySignals {
  setEl$: Command<(() => void) | undefined, [HTMLElement | null]>;
}
```

## Signal Factory Pattern

Refactored the signal handling to avoid global singletons when multiple signals exist within a single page.

In previous requirements, we only needed a single chat session per page, so we used global singleton signals. This was not an issue at the time.

However, as we refactor the code to support multiple chat sessions within a single page, we must implement the Signal Factory pattern to prevent global singleton conflicts.

Each factory call returns fresh `state()`/`computed()`/`command()` instances, so multiple instances can coexist without sharing state.

### Module-level singletons

```typescript
// chat-message.ts
const internalLocalMessages$ = state<ZeroChatMessage[]>([]);
export const resetLocalMessages$ = command(({ set }) => {
  set(internalLocalMessages$, []);
});
export const messages$ = computed(async (get) => {
  /* ... */
});
export const allFinished$ = computed(async (get) => {
  /* ... */
});
export const sendMessage$ = command(async ({ get, set }, prompt, signal) => {
  /* ... */
});

// chat-auto-scroll.ts
import { onRef } from "../utils.ts";

const chatScrollContainer$ = state<HTMLElement | null>(null);
export const setChatScrollContainer$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(chatScrollContainer$, null);
    });
    set(chatScrollContainer$, el);
  }),
);
export const autoScroll$ = command(({ get }) => {
  /* ... */
});
```

```typescript
// View imports singletons directly — can't have two threads on screen
import {
  messages$,
  sendMessage$,
} from "../../signals/chat-page/chat-message.ts";
import { setChatScrollContainer$ } from "../../signals/chat-page/chat-auto-scroll.ts";

export function ChatPage() {
  const msgs = useLastLoadable(messages$);
  // ...
}
```

### Factory function returning a signals interface

The Signals Factory allows a single page to contain multiple sets of Signals.

While this approach is more complex than using a singleton, it provides a viable solution for managing multiple distinct page instances within a single view.

**Step 1 — Define the interface and factory:**

```typescript
// create-chat-thread.ts
import { command, computed, state, type Command, type Computed } from "ccstate";
import { onRef } from "../utils.ts";

export interface ChatThreadSignals {
  messages$: Computed<Promise<ZeroChatMessage[]>>;
  allFinished$: Computed<Promise<boolean>>;
  sendMessage$: Command<Promise<void>, [string, AbortSignal]>;
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  draft: DraftSignals;
}
```

**Step 2 — Break into sub-factories for each concern:**

```typescript
function createMessageState(threadData$: Computed<Promise<ThreadData | null>>) {
  const internalLocalMessages$ = state<ZeroChatMessage[]>([]);

  const messages$ = computed(async (get) => {
    const serverMsgs = (await get(threadData$))?.chatMessages ?? [];
    const localMsgs = get(internalLocalMessages$);
    return [...transformServerMessages(serverMsgs), ...localMsgs];
  });

  const allFinished$ = computed(async (get) => {
    /* ... */
  });

  return {
    internalLocalMessages$,
    messages$,
    allFinished$,
  };
}

function createScrollSignals() {
  const container$ = state<HTMLElement | null>(null);

  const setScrollContainer$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(container$, null);
      });
      set(container$, el);
    }),
  );

  return { setScrollContainer$ };
}
```

**Step 3 — Compose sub-factories in the main factory:**

```typescript
export function createChatThreadSignals(
  threadId: string,
  existingDraft?: DraftSignals,
): ChatThreadSignals {
  const { threadData$, reloadThread$ } = createThreadData(threadId);
  const {
    internalLocalMessages$,
    messages$,
    allFinished$,
  } = createMessageState(threadData$);
  const { setScrollContainer$ } = createScrollSignals();
  const draft = existingDraft ?? createDraftSignals();

  const { sendMessage$ } = createMessageCommands({
    threadId,
    threadData$,
    reloadThread$,
    internalLocalMessages$,
    draft,
  });

  return {
    messages$,
    allFinished$,
    sendMessage$,
    setScrollContainer$,
    draft,
  };
}
```

**Step 4 — Derive from route via package-scope computed, pass as prop:**

```typescript
// create-chat-thread.ts
export const currentChatThreadSignals$ = computed(
  (get): ChatThreadSignals | null => {
    const threadId = get(currentChatThreadId$);
    if (!threadId) return null;
    return createChatThreadSignals(threadId);
  },
);

// chat-page-setup.ts
export const setupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const threadId = get(currentChatThreadId$);
    const thread = get(currentChatThreadSignals$)!;

    set(
      updatePage$,
      createElement(ZeroChatThreadPage, { key: threadId, thread }),
    );
    // ...
    await set(thread.loadMessages$, signal);
  },
);
```

No manual cache needed — ccstate `computed` memoizes the last result. As long as `currentChatThreadId$` hasn't changed, the same `ChatThreadSignals` object is returned without re-creation.

**Step 5 — Components consume via props:**

```typescript
export function ZeroChatThreadPage({ thread }: { thread: ChatThreadSignals }) {
  const messagesLoadable = useLastLoadable(thread.messages$);
  const setScrollContainer = useSet(thread.setScrollContainer$);
  // ... pass thread down to children ...
}
```

### Key rules

1. **Interface first** — define a `Signals` interface listing only the public signals. Keep internal `state()` atoms private to the factory.
2. **Sub-factories for each concern** — split message state, scroll, draft, commands, etc. into separate functions. The main factory composes them.
3. **Dependencies via parameters** — sub-factories receive the signals they depend on as arguments, not module-level imports.
4. **Pass as React props** — the factory result is a plain object, so pass it as a prop. Use `useGet(thread.someSignal$)` / `useSet(thread.someCommand$)` in components.
5. **`key` prop for remount** — when creating the component element, use `key: threadId` so React remounts when the thread changes, avoiding stale hook state.
6. **Allow dependency injection** — accept optional existing signal groups (e.g., `existingDraft?: DraftSignals`) so the caller can share state across factories when needed.
7. **Helpers that were only used by singletons can be inlined** — if a hook or utility existed only to wrap singleton signals (e.g., `useFileUploadHandlers`), inline its logic directly into the component once signals are injected via props.
