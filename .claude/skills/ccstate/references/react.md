# React and DOM ownership

[ccstate guide](../SKILL.md)

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
