# Reactive values and state

[ccstate guide](../SKILL.md)

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
if (typeof val === "function") {
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
    const result = await get(apiClient$)(contract).list();
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
  const result = await accept(get(apiClient$)(contract).list(), [200]);
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
// Loading from loadable state
const agentsLoadable = useLoadable(agents$);
const loading = agentsLoadable.state === "loading";

// Last resolved value (keeps showing old data while reloading)
const agents = useLastResolved(agents$) ?? [];
```
