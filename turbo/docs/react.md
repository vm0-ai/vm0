# React Performance Patterns

This document records React re-render anti-patterns discovered through CPU profiling in this codebase, along with their root causes and fixes.

---

## Background: How to Identify Excessive Re-renders

Dense `renderWithHooksAgain` samples in a CPU profile indicate that a component is being forced to re-execute within the same render pass. This is triggered when `useSyncExternalStore` detects that the snapshot has changed during render, causing React to immediately re-run that component's render function.

---

## Anti-Pattern 1: Subscribing to Multiple Async Signals at the Top of a Large Component

### Problem

A parent component (e.g. `ZeroSidebar`) subscribes to multiple async signals at the top level simultaneously:

```tsx
// ❌ Every time an async signal resolves, the entire large component re-renders
export function ZeroSidebar() {
  const displayNameLoadable = useLastLoadable(currentChatAgentDisplayName$);
  const subagentsLoadable = useLastLoadable(subagents$);
  const defaultDisplayName = useLastResolved(defaultAgentName$);
  const features = useLastResolved(featureSwitch$);
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$);
  const currentChatAgentId = useResolved(currentChatAgentId$); // 2 Promise transitions → 4 re-renders
  // ...
  // Large JSX block that fully executes on every re-render
}
```

### Why This Is Harmful

- Every async signal resolution triggers a full component re-render, including recomputation of all nav items and full DOM reconciliation
- Signals using `useResolved` (keepLastResolved=false) produce 2 renders per Promise transition (loading → hasData) rather than 1; signals that depend on another async computed chain accumulate more transitions
- Total renders = Σ (number of Promise transitions per signal × renders per transition)

### Fix: Push Subscriptions Down to Leaf Components

Move async subscriptions into the smallest subcomponent that actually needs the data:

```tsx
// ✅ Each component subscribes only to the signals it needs

function ChatThreadsSectionWithKey() {
  const currentChatAgentId = useResolved(currentChatAgentId$);
  return <ChatThreadsSection key={currentChatAgentId} />;
}

function ManagePinnedAgentsDialogContainer() {
  const displayNameLoadable = useLastLoadable(currentChatAgentDisplayName$);
  const subagentsLoadable = useLastLoadable(subagents$);
  const [pinLoadable, save] = useLoadableSet(updatePinnedAgentIds$);
  // ...renders dialog only, does not affect nav
}

function SidebarNavContent() {
  const features = useLastResolved(featureSwitch$);
  const defaultDisplayName = useLastResolved(defaultAgentName$);
  const slackScopeMismatch = useLastResolved(slackOrgScopeMismatch$);
  // ...renders nav content
}

export function ZeroSidebar() {
  // Zero async subscriptions — renders exactly once on page load
  return (
    <VM0ClerkProvider>
      <SidebarNavContent />
      <ManagePinnedAgentsDialogContainer />
      <BillingDialog />
    </VM0ClerkProvider>
  );
}
```

---

## Anti-Pattern 2: Using `useResolved` (keepLastResolved=false) on Async Computed Chains

### Problem

`useResolved` uses `useLoadable` (keepLastResolved=false) internally, triggering 2 renders per Promise transition (loading → hasData) instead of 1. When a signal depends on another async computed, the transition counts compound:

```tsx
// agent-chat.ts
export const currentChatAgentId$ = computed(async (get) => {
  return get(internalChatAgentId$) ?? (await get(defaultAgentId$));
  // defaultAgentId$ is itself async → 2 Promise transitions
});

// View layer
const currentChatAgentId = useResolved(currentChatAgentId$);
// Result: 2 transitions × 2 renders/transition = 4 extra re-renders
```

### Fix: Prefer `useLastResolved`

If a component only needs the most recently resolved value and does not need to track loading state, use `useLastResolved` (keepLastResolved=true):

```tsx
// ✅ Only 1 render per Promise transition, and no flash back to undefined during loading
const defaultDisplayName = useLastResolved(defaultAgentName$) ?? "Zero";
```

Only use `useLoadable` / `useResolved` when the component **needs to react to the loading state** (e.g. to show a skeleton).

---

## Anti-Pattern 3: Passing Async-Derived Data via Props (Prop Drilling)

### Problem

A parent component subscribes to async signals and then passes the resolved values as props down through the tree:

```tsx
// ❌ Parent takes on subscriptions it doesn't own; re-renders on every async update
export function ZeroSidebar() {
  const displayName  = useLastResolved(currentChatAgentDisplayName$);
  const subagents    = useLastResolved(subagents$);
  const savingPinned = ...; // from useLoadableSet

  return (
    <ManagePinnedAgentsDialog
      displayName={displayName}
      subagents={subagents}
      saving={savingPinned}
      // ...
    />
  );
}
```

### Why This Is Harmful

- The parent subscribes to signals it doesn't need for its own UI, just to pass data to a child
- Every update to those signals re-renders the entire parent tree, even when the parent's own UI hasn't changed

### Fix: Child Components Subscribe Directly

```tsx
// ✅ Dialog container owns its subscriptions; parent passes zero props
function ManagePinnedAgentsDialogContainer() {
  const displayNameLoadable = useLastLoadable(currentChatAgentDisplayName$);
  const subagentsLoadable   = useLastLoadable(subagents$);
  const [pinLoadable, save] = useLoadableSet(updatePinnedAgentIds$);
  // ...
  return <ManagePinnedAgentsDialog ... />;
}
```

---

## Verification Methods

### Controlled Experiment: Incrementally Remove Subscriptions

Add a render counter to the top of a component and use tests to progressively remove subscriptions, confirming each signal's contribution to the render count:

```tsx
let _renderCount = 0;
export function getTestRenderCount() {
  return _renderCount;
}

export function ZeroSidebar() {
  _renderCount++;
  // ...
}
```

### CPU Profile Analysis

- Dense `renderWithHooksAgain` samples → excessive re-renders present
- `analyze-batching.mjs`: confirm whether multiple signal updates are batched within the same React work loop
- `analyze-rewind-cause.mjs`: pinpoint which snapshot function triggers `renderWithHooksAgain`
- `dump-rewind-chains.mjs`: view the full call chain to identify the re-render source

### Confirming React Batching

When multiple signals update within the same microtask, React batches them into a single `renderRootSync`. This can be confirmed by analyzing a CPU profile: 1,318 `renderWithHooksAgain` samples distributed across only 11 `renderRootSync` instances confirms that batching is working correctly.

---

## Render Count Formula

For a component subscribed to N async signals, the number of extra renders on page load is:

```
extra renders = Σ (Promise transitions for signal_i × renders per transition_i)

Renders per transition:
  useLastResolved / useLastLoadable  → 1 render/transition (keepLastResolved=true)
  useResolved / useLoadable          → 2 renders/transition (keepLastResolved=false)

Promise transition count:
  direct async computed              → typically 1
  chain depending on another async   → transition counts compound (e.g. currentChatAgentId$ via two hops → 2)
```
