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

1. **Always use `pageSignal$`**: Get the page signal using `useGet(pageSignal$)` instead of creating a new `AbortController`
2. **Use `detach()` instead of `void`**: The `detach()` function properly handles promise rejection and tracks the promise for testing
3. **Use `Reason.DomCallback`**: This enum value indicates the promise is from a DOM event handler
4. **Never use `void` operator**: Using `void` silences the lint error but doesn't properly handle the promise

### Why This Pattern

- **Proper abort handling**: `pageSignal$` is automatically aborted when the page unmounts, canceling any in-flight operations
- **Test tracking**: `detach()` collects promises in test environments for proper cleanup
- **Error handling**: `detach()` re-throws non-abort errors to ensure bugs aren't silenced
- **Semantic clarity**: `Reason.DomCallback` documents why the promise is intentionally detached

### Other Reason Types

```typescript
export enum Reason {
  DomCallback = "dom_callback",  // For DOM event handlers
  Entrance = "entrance",          // For application entry points
  Deferred = "deferred",          // For deferred operations
  Daemon = "daemon",              // For background daemon processes
}
```

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
    setup: setupAuthPageWrapper(setupLogsPage$),  // Wrapper sets pageSignal$ automatically
  },
];
```

**How it works**:
1. Route navigation triggers `loadRoute$` (in route.ts)
2. `loadRoute$` calls `setupAuthPageWrapper(setupLogsPage$)`
3. `setupAuthPageWrapper` internally calls `setupPageWrapper`
4. `setupPageWrapper` sets `pageSignal$` before calling your setup command
5. Your setup command receives the signal and can access `pageSignal$` in components

**Never manually set pageSignal$ in setup commands** - the wrapper does it for you.

## Removing `ccstate-react/experimental` from Views

The ESLint rule `ccstate/no-use-ccstate-in-views` bans all imports from `ccstate-react/experimental` in `views/` files. Many files suppress this with `/* eslint-disable ccstate/no-use-ccstate-in-views */`. This section documents how to eliminate each experimental hook.

### Remaining violations

23 files in `views/zero-page/` still have `eslint-disable ccstate/no-use-ccstate-in-views`. Run this to find them:

```bash
grep -rl "eslint-disable ccstate/no-use-ccstate-in-views" turbo/apps/platform/src/views/
```

### Pattern 1: Replace `useCCState` with `state()` in signals

`useCCState` creates component-local ccstate atoms inline. Replace with a `state()` declared in the corresponding `signals/` file.

**Before (view):**
```typescript
/* eslint-disable ccstate/no-use-ccstate-in-views */
import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet } from "ccstate-react";

function MyComponent() {
  const search$ = useCCState("");
  const search = useGet(search$);
  const setSearch = useSet(search$);
}
```

**After (signals file):**
```typescript
const internalSearch$ = state("");

export const mySearch$ = computed((get) => get(internalSearch$));

export const setMySearch$ = command(({ set }, value: string) => {
  set(internalSearch$, value);
});
```

**After (view):**
```typescript
import { useGet, useSet } from "ccstate-react";
import { mySearch$, setMySearch$ } from "../../signals/my-signals.ts";

function MyComponent() {
  const search = useGet(mySearch$);
  const setSearch = useSet(setMySearch$);
}
```

**Key decisions:**
- If the state should reset when context changes (e.g., navigating to a different detail page), add a `set(internalSearch$, "")` in the relevant sync/init command
- If the state is truly view-local and doesn't need cross-component sharing, it still goes in signals — this project does NOT use React `useState`
- Naming: `internal*$` for the raw state, exported `computed` for reading, exported `command` for writing

### Pattern 2: Replace `useCommand` with `command()` in signals

`useCommand` creates inline commands inside components. Extract to the signals file.

**Before (view):**
```typescript
import { useCommand } from "ccstate-react/experimental";

function MyComponent() {
  const handleSave$ = useCommand(async ({ get, set }) => {
    const data = get(someData$);
    await set(saveCommand$, data);
  });
  const handleSave = useSet(handleSave$);
}
```

**After (signals file):**
```typescript
export const handleSave$ = command(async ({ get, set }) => {
  const data = get(someData$);
  await set(saveCommand$, data);
});
```

**After (view):**
```typescript
import { useSet } from "ccstate-react";
import { handleSave$ } from "../../signals/my-signals.ts";

function MyComponent() {
  const handleSave = useSet(handleSave$);
}
```

### Pattern 3: Replace `useCommand` + `onRef` — move trigger to route setup

This is the most important pattern. `onRef` is designed for binding side effects to DOM element lifecycle (mounting/unmounting). It should only be used when the command **actually needs the DOM element or the unmount AbortSignal**.

**Bad smell:** `useCommand` + `onRef` where the command ignores both `el` and `signal`:
```typescript
// ❌ onRef used as "run on mount" hack — command doesn't use el or signal
const initPage$ = useCommand(({ set }) => {
  set(syncSomething$);
});
const initPageRef$ = onRef(initPage$);
const initPageRef = useSet(initPageRef$);
// ... ref must be forwarded to child components
return <ChildComponent ref={initPageRef} />;
```

**Root cause:** The command is purely data-layer work (no DOM dependency), but it's wrapped in `onRef` just to trigger on component mount. This forces ref forwarding through child components that don't care about the ref.

**Fix:** Move the trigger to the route setup layer. Every zero page route already goes through `setupZeroPage$` which runs on each route change. Add the sync call to an existing `*IfActive$` guard command, or create a new one:

```typescript
// ✅ Trigger from route setup — no DOM coupling, no ref forwarding
export const refreshMyTabIfActive$ = command(({ get, set }) => {
  const activeTab = get(zeroActiveId$);
  if (activeTab !== "mytab") return;
  set(syncMyTabState$);
  detach(set(refreshMyTabData$), Reason.Entrance);
});
```

Then call it from `setupZeroPage$` in `signals/zero-page/zero-page.ts`.

**When `onRef` IS appropriate:**
```typescript
// ✅ Command actually uses the DOM element and AbortSignal
const watchOrgSwitch$ = command(async ({ get }, el: HTMLElement, signal: AbortSignal) => {
  // Listens to DOM events on el, cleans up via signal
});
export const orgSwitcherRef$ = onRef(watchOrgSwitch$);
```

### Decision flowchart

```
Found `ccstate-react/experimental` import in a view file?
│
├─ Uses `useCCState`?
│  └─ Move to signals/ as state() + computed() + command()
│     Reset in the appropriate init/sync command if needed
│
├─ Uses `useCommand` WITHOUT `onRef`?
│  └─ Extract command() to signals/ file, consume with useSet()
│
├─ Uses `useCommand` WITH `onRef`?
│  ├─ Does the command use `el` or `signal` from onRef?
│  │  ├─ YES → Extract to signals/ as command() + onRef(), keep ref in view
│  │  └─ NO → Remove onRef entirely, trigger from route setup layer
│  │          Remove ref prop forwarding from child components
│  └─ (Check: is onRef's AbortSignal actually consumed? If not, it's a no-op)
│
└─ After all experimental imports removed:
   Remove the `/* eslint-disable ccstate/no-use-ccstate-in-views */` comment
   Remove the `import ... from "ccstate-react/experimental"` line
   Run `pnpm knip` to check for newly-unused exports
```

### Verification checklist

After refactoring each file:
1. `eslint-disable` comment removed
2. `ccstate-react/experimental` import removed
3. No `ref` props that exist solely for forwarding init refs
4. `pnpm turbo run lint` passes
5. `pnpm check-types` has no new errors
6. `pnpm knip` has no unused exports (newly-internal signals should lose `export`)
7. Existing tests still pass
