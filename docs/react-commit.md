# React Commit Analysis

This guide describes how to measure excessive React work, identify the state
subscription that caused it, and reduce unnecessary work in the VM0 platform.
The examples use `ccstate-react`, but the measurement method applies to any
React external store.

The dated trace sections below are records of what was measured on a specific
day. Component, hook, and signal names inside them are the names that existed
at the time, and some have since been renamed or removed by the very fixes the
section describes. Read them as evidence, not as a current symbol index.

## What to Measure

React performance investigations need three separate measurements:

1. **Commits**: how many times React applied a completed tree to a root.
2. **Component executions**: which component functions participated in each
   commit.
3. **Commit duration**: how much development-mode render time React attributed
   to the commits.

These measurements answer different questions. A commit can be valid because a
streaming message changed while still doing unnecessary work in the sidebar.
Conversely, a component function can execute without producing a DOM mutation.
Reducing component executions inside necessary commits is still a meaningful
optimization.

Do not use DOM mutation counts as a substitute for React commit counts, and do
not treat a component execution as proof that the browser painted.

## Establish a Reproducible Scenario

Before changing code:

1. Use a development build. Production timings and development timings are not
   directly comparable.
2. Open the same route with the same visible data and the same number of sidebar
   rows.
3. Let initial data, lazy modules, fonts, and suspense boundaries settle.
4. Enter the prompt before resetting the profiler. Typing is not part of the
   send-to-completion measurement.
5. Reset immediately before clicking Send.
6. Stop only after the run reaches a terminal state and the composer returns to
   its idle state.
7. Record the backend event count or stream update count alongside the React
   measurements.

Streaming runs are often nondeterministic. Queue time, polling, event batching,
and the number of streamed updates can change between runs. A result such as
`44 commits` versus `42 commits` is not meaningful if the two runs processed a
different number of events.

Prefer a fixed mocked event sequence. If that is unavailable, report normalized
metrics such as commits per event and component executions per event. Run the
scenario more than once and retain the raw results.

## Instrument React Commits

The React DevTools global hook can count root commits without adding permanent
profiling components to the application. Keep this instrumentation deliberately
small: the hook is reliable for root commit boundaries, but a traversal of
private Fiber fields is not a reliable component execution log.

Install the following script from the browser console after the page has
loaded:

```js
(() => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) throw new Error("React DevTools hook is unavailable");
  if (window.__vm0ReactCommitProfiler) return;

  const state = {
    profile: null,
  };
  const originalOnCommitFiberRoot = hook.onCommitFiberRoot;

  hook.onCommitFiberRoot = function onCommitFiberRoot(id, root) {
    const profile = state.profile;

    if (profile) {
      profile.commits += 1;
      const duration = root.current.actualDuration;
      if (typeof duration === "number" && Number.isFinite(duration)) {
        profile.duration += duration;
      }
      profile.timeline.push({
        atMs: performance.now() - profile.startedAt,
        duration,
      });
    }

    return originalOnCommitFiberRoot?.apply(this, arguments);
  };

  window.__vm0ReactCommitProfiler = {
    start() {
      state.profile = {
        startedAt: performance.now(),
        commits: 0,
        duration: 0,
        timeline: [],
      };
    },
    stop() {
      const result = state.profile;
      state.profile = null;
      return result;
    },
    uninstall() {
      hook.onCommitFiberRoot = originalOnCommitFiberRoot;
      delete window.__vm0ReactCommitProfiler;
    },
  };
})();
```

Start immediately before the measured action:

```js
window.__vm0ReactCommitProfiler.start();
```

After the run finishes, retain both the total and timeline:

```js
const result = window.__vm0ReactCommitProfiler.stop();
result;
```

Call `uninstall()` after the investigation so a later console session does not
stack another wrapper around the hook. `actualDuration` is a private React
field and development-only relative metric; revalidate the script after a
React upgrade.

### Use React Performance Tracks for Attribution

Capture the same bounded interaction with `agent-browser`:

```bash
agent-browser profiler start
# Perform the measured interaction in the browser.
agent-browser profiler stop tmp/chat-send.trace.json
```

The resulting file is a Chrome trace containing React Performance tracks, not
a raw V8 `.cpuprofile`. Load it in the Chrome Performance panel and inspect:

- `Update` and `Cascading Update` events in `Scheduler ⚛` for the component
  and hook that scheduled work;
- component spans in `Components ⚛` for changed props, referentially unequal
  closures, and deeply equal objects;
- the span duration for the expensive subtree, while remembering that parent
  and child durations are inclusive and must not be added together.

The repository's `analyze-react-renders.mjs` and
`analyze-call-frequency.mjs` scripts accept a raw V8 CPU profile. Do not pass
the Chrome trace container to those scripts. Capture a raw CPU profile or
extract its `Profile` and `ProfileChunk` events first when sampled JavaScript
stacks are needed.

## Avoid Fiber Counting False Positives

Do not infer component executions by traversing every Fiber after a root
commit. The following approaches all overcount in current React builds:

- Counting every fiber with the `PerformedWork` flag. Flags can remain visible
  on reused or bailed-out subtrees after a commit.
- Comparing `fiber.actualStartTime` directly with
  `fiber.alternate.actualStartTime`. React alternates between two fiber objects,
  so this can count historical work from the other buffer.
- Keeping a `WeakMap` of each Fiber's previous `actualStartTime`. React can
  retain or copy timing data while traversing an ancestor or bailed-out
  subtree, so a changed value is still not proof that the component function
  executed.

In one chat sample, the `WeakMap` technique reported 76 sidebar executions.
The React Performance track for the same trace showed no execution spans for
`SidebarLayout`, `Sidebar`, or `ChatThreadsContent`; the only visible
sidebar update initiator was one `ChatThreadItem`. Use the root hook for exact
commit boundaries and React Performance tracks or a deliberately placed React
`Profiler` for component attribution.

Also account for these sources of noise:

- React Strict Mode can intentionally invoke render logic more than once in
  development.
- Hot module replacement invalidates the current sample.
- Opening a popover, typing, scrolling, or changing focus adds unrelated work.
- Development-mode `actualDuration` is useful for relative comparisons only.
- A newly mounted component legitimately appears as work and should be
  separated from repeated updates.

## Divide the Page into Regions

Start with a small region table instead of inspecting hundreds of component
names:

| Region        | Representative components               | Expected updates during streaming                                              |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| Sidebar       | `ChatThreadsContent`, `ChatThreadItem`  | Only thread metadata, unread, draft, active-run, route, or pane changes        |
| Message list  | `ChatThreadContent`, message group rows | New or changed message/run data and render-window changes                      |
| Composer      | `ChatThreadComposer`, composer controls | Input, send state, queue state, selected model, or relevant capability changes |
| Global layout | `Router`, `SidebarLayout`, providers    | Route, layout, auth, theme, or provider value changes                          |

For repeated components, record both the aggregate count and the visible item
count. If four sidebar rows each execute ten times, report 40 row executions,
not merely that `ChatThreadItem` appeared in ten commits.

## Trace the Trigger

For every unexpectedly active component, inventory these inputs:

1. `useGet`, `useLastResolved`, `useLoadable`, and `useLastLoadable`
   subscriptions.
2. React context values.
3. Props created by the parent.
4. Local state and reducer updates.
5. A changing `key`, which causes a remount instead of an update.

Then classify each subscribed value:

- primitive or reference;
- synchronous or Promise-backed;
- stable or newly allocated on recomputation;
- visually relevant or used only to derive a primitive;
- expected to change for every stream event or only for a specific domain
  event.

The important question is not merely "what changed?" It is "did the semantic
value used by this component change?"

## Preferred Fixes

Apply fixes in this order.

### 1. Subscribe to the Smallest Semantic Value

If rendering only needs a boolean or identifier, expose that primitive from the
signal factory:

```ts
const hasChatGroups$ = computed(async (get): Promise<boolean> => {
  return (await get(groupedChatMessages$)).length > 0;
});

const selectedModel$ = computed(async (get): Promise<string | null> => {
  return (await get(modelSelection$))?.selectedModel ?? null;
});
```

Primitives let `Object.is` suppress unchanged values cheaply. Do not subscribe
to an entire group list or model-selection object just to calculate one boolean
or string in React.

ccstate computed values already memoize their last result while dependencies
remain unchanged. Do not add a manual cache merely to duplicate that behavior.

### 2. Subscribe Only to Loadable State When Data Is Not Used

This pattern subscribes to every loadable object update:

```ts
const loadable = useLoadable(resource$);
const loading = loadable.state === "loading";
```

If the component only needs the lifecycle state, use the primitive hook:

```ts
const state = useLoadableState(resource$);
const loading = state === "loading";
```

Do not replace `useLastLoadable` mechanically. `useLastLoadable` intentionally
keeps the previous resolved value during refetch, whereas `useLoadableState`
returns `loading` for a replacement Promise. Confirm that the UI should expose
that transition before changing the hook.

### 3. Use Hook Equality for Equivalent Collections

`useGet`, `useLastResolved`, and `useLastLoadable` use `Object.is` by default.
When a computed produces a new array or set with the same semantic contents,
pass an explicit equality function at the React boundary:

```ts
const unreadIds = useLastResolved(unreadThreadIds$, {
  equalityFn: equalSets,
});

const groups = useLastLoadable(renderedGroups$, {
  equalityFn: equalArrays,
});
```

Keep collection comparators small and predictable:

```ts
export function equalArrays<T>(
  previous: readonly T[],
  next: readonly T[],
  equalItem: (previous: T, next: T) => boolean = Object.is,
): boolean {
  return (
    previous === next ||
    (previous.length === next.length &&
      previous.every((item, index) => equalItem(item, next[index]!)))
  );
}

export function equalSets<T>(
  previous: ReadonlySet<T>,
  next: ReadonlySet<T>,
): boolean {
  return (
    previous === next ||
    (previous.size === next.size &&
      Array.from(previous).every((item) => next.has(item)))
  );
}
```

For arrays of objects, use a domain comparator that includes every field that
can affect rendering or ordering. Equality is incorrect if it hides a visible
change. Avoid general recursive deep equality in a hot path unless measurement
shows that its comparison cost is lower than the work it prevents.

### 4. Separate Presence from Payload

A component often needs to know whether a payload exists before it needs the
payload itself. Expose both values:

```ts
const hasQueuedUserMessages$ = computed(async (get) => {
  return (await get(groupedChatMessages$)).some(hasQueuedUserMessage);
});

const queuedUserMessages$ = computed(async (get) => {
  return collectQueuedUserMessages(await get(groupedChatMessages$));
});
```

React hooks cannot be called conditionally. Select between the real signal and
a stable empty signal, then call the hook once:

```ts
const hasQueued = useLastResolved(thread.hasQueuedUserMessages$) ?? false;
const messages$ = hasQueued
  ? thread.queuedUserMessages$
  : thread.emptyQueuedUserMessages$;
const messages = useLastResolved(messages$, {
  equalityFn: equalArrays,
});
```

### 5. Remove Duplicate Subscriptions

Do not subscribe to both a source collection and a rendered projection unless
the component actually uses both semantic values. A composer that only needs
`hasMessages` should not subscribe to `groupedChatMessages$`. A message window
may legitimately need both the full group list and the rendered slice; use
equality to suppress equivalent arrays in that case.

### 6. Keep Subscriptions Close to Their Consumers

Avoid passing volatile computed collections through several component layers.
Subscribe in the component that uses the value. This reduces prop coupling and
makes the subscription visible at the render boundary.

Stable props and `React.memo` can prevent parent-driven executions, but they do
not stop updates caused by a component's own external-store subscription.
Narrow the subscription first; add memoization only when profiling still shows
parent-driven work.

### 7. Avoid No-op State Writes and Broad Invalidation

A realtime notification should not rewrite snapshots, event arrays, counters,
or derived state when no new remote data arrived. No-op writes can invalidate a
large computed graph even though the visible domain state is unchanged.

For event-sourced thread data:

- keep the in-memory snapshot and event array as the runtime source of truth;
- append only newly fetched events;
- replace the snapshot only when recovery actually fetched a new snapshot;
- let `threads$` derive from snapshot and events;
- do not add a `syncVersion` or reload counter solely to force replay.

### 8. Use Keys for Identity, Not Render Suppression

A correct key lets React preserve the identity of a row when list order changes.
It does not prevent rerenders. A key that changes unnecessarily forces an
unmount and remount, discards local state, and can increase memory churn.

Use stable domain identifiers such as `thread.id`. Never use a newly allocated
object or an array index when the item has a stable identifier.

## Validate the Fix

Use three validation layers:

1. **Hook integration tests**: wrap a consumer in React `Profiler` and assert
   that an equivalent value causes zero additional commits while a semantic
   change causes exactly one.
2. **Page tests**: exercise user-visible behavior through the normal platform
   page setup. Equality changes must not hide title, unread, running, queue, or
   message changes.
3. **Real-browser profiling**: repeat the fixed streaming scenario and compare
   region execution counts, commit counts, and duration.

Example `Profiler` assertion:

```tsx
const onRender = vi.fn();

render(
  <Profiler id="consumer" onRender={onRender}>
    <Consumer />
  </Profiler>,
);

onRender.mockClear();
store.set(ids$, new Set(["thread-1"]));
await Promise.resolve();
expect(onRender).not.toHaveBeenCalled();
```

Test a later semantic change as well. A test that only verifies suppression can
pass with an equality function that incorrectly returns `true` for everything.

## Example: Chat Sidebar Optimization

One investigation started with 121 commits during a send. Earlier subscription
narrowing reduced a later sample to 44 commits. Because the stream event count
was not fixed, those totals describe observed runs rather than a controlled
benchmark.

A more useful A/B comparison inspected actual region executions:

| Variant                     | Observed commits | `ChatThreadsContent` executions | Sidebar row executions |
| --------------------------- | ---------------: | ------------------------------: | ---------------------: |
| Without collection equality |               54 |                               9 |                     30 |
| With collection equality    |               20 |                               0 |                      0 |

The runs entered different stream/queue phases, so their total commit counts and
durations are not directly comparable. The region result is still actionable:
equivalent thread lists and draft/unread/active ID sets no longer scheduled or
executed the sidebar subtree during the optimized run.

The same optimized sample still executed `ChatThreadContent` and
`ChatThreadComposer` 13 times. Those components consume real message, run, and
composer primitives, so collection equality alone cannot eliminate their work.
Continue by attributing each execution to a specific primitive transition.

## Chat Send Attribution History

The dated samples below are historical baselines. Their counts describe the
recorded code revision, capture window, visible data, and backend event
sequence; they are not current performance guarantees.

The initial sample below measured an existing chat thread in a local
development build before removing the React-driven thinking typewriter. The
prompt was entered before profiling, and the measurement began immediately
before Send. The local run produced and fully revealed a thinking message but
did not emit a final or terminal event, so it was cancelled after profiling.
The results identify update sources; they are not a send-to-completion
benchmark.

Two immediately repeated sends with the same thread, model, and prompt provided
complementary data:

| Sample                                              | Result                                                      |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Root commit counter, first five seconds             | 62 commits; the final measured commit was at 3.439 seconds  |
| Root commit counter, first second                   | 20 commits                                                  |
| Root commit counter, 1.0 through 3.439 seconds      | 42 commits; 45 adjacent intervals were between 20 and 45 ms |
| React scheduler track, separate equivalent send     | 49 `Update` events and 7 `Cascading Update` events          |
| Scheduler activity after thinking text was revealed | None before the run was manually cancelled                  |

Scheduler events are update initiators, not commits. React may batch multiple
initiators into one commit, schedule cascading work from a commit, or commit
work without a separately labelled scheduler event. Do not add or compare the
two totals directly.

### Scheduler update sources

The React scheduler track attributed the 56 labelled updates as follows:

| Update initiator              | Count | Interpretation                                                     |
| ----------------------------- | ----: | ------------------------------------------------------------------ |
| `ThinkingIndicator`           |    39 | Typewriter frames written at a nominal 28 ms interval              |
| `AgentListDialog`             |     5 | A closed dialog remained subscribed to changing thread-list data   |
| `ChatThreadContent`           |     4 | Optimistic message, reconciliation, and remote message projections |
| `ChatThreadComposer`          |     4 | Send/loading/run-state transitions                                 |
| `WorkflowComposerPlaceholder` |     1 | Draft/composer transition during Send                              |
| `ChatThreadHeader`            |     1 | Thread metadata transition                                         |
| `AssistantBubbleAvatar`       |     1 | Assistant identity became available to the new response row        |
| `ChatThreadItem`              |     1 | The visible sidebar row changed to its active-run indicator        |

A pre-change ccstate watcher probe showed the same separation. During one sample,
`displayedThinkingText$` notified its React watcher 42 times, while the main
message and run projections such as `groupedChatMessages$`,
`renderedGroupedChatMessages$`, `allFinished$`, `hasChatGroups$`, and
`lastAssistantCancelled$` each notified watchers about five times. A watcher
notification is only a computed reevaluation: primitive equality in
`useLastResolved` can still prevent a React update when its semantic result did
not change.

### Work by page region

The component track gives a more accurate region picture than Fiber traversal:

| Region            | Observed component work                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| Visible sidebar   | One direct `ChatThreadItem` update; no spans for `SidebarLayout`, `Sidebar`, or `ChatThreadsContent`                  |
| Hidden sidebar UI | Five direct `AgentListDialog` updates while the dialog was closed                                                     |
| Message list      | Four direct `ChatThreadContent` updates; `ChatThreadMessagesMain` and `ChatThreadMessageGroups` each executed 8 times |
| Composer          | Four direct `ChatThreadComposer` updates; its main leaf slots executed 11 times                                       |
| Thinking row      | 39 direct `ThinkingIndicator` updates; `WaitingForAssistantResponse` executed 46 times                                |

The direct update component is the root of that scheduled work and may not have
its own component span. Descendant span counts can therefore be higher than the
direct update count.

The message-list spans exposed unnecessary identity churn:

- `PagedUserMessage` executed five times. Four executions only received a new,
  deeply equal `message.blocks`; one was the real optimistic-to-persistent
  reconciliation.
- `PagedAssistantMessageItem` executed three times, and all three received new,
  deeply equal `message.blocks`.
- `UserMessageActions` executed 14 times with only a new `onCopy` closure.

`createTranscriptMessagesComputed` currently maps the complete raw transcript
whenever persistent or optimistic messages change. It calls
`parseBodyRenderBlocks` and `enrichBlocksWithTextPreviews` for every message,
creating new enriched messages and block arrays. `groupMessagesForDisplay` then
creates new group and message arrays. The shallow `equalArrays` used by
`ChatThreadContent` cannot suppress this update because the group objects are
new even when every old message is semantically unchanged.

The composer spans showed a different hot path:

- `TiptapWorkflowComposer` executed 11 times and consumed about 3.8 ms of
  inclusive development-mode span time. Ten executions only changed
  `onDraftChange`, `onKeyDown`, and `onPaste` closure identities; one also
  changed the semantic `sending` prop.
- `ComposerModelPickerSlot` also executed 11 times. Its `modelPicker.value` was
  repeatedly referentially unequal but deeply equal, and its callbacks were
  recreated.
- The closed model picker still rendered its select-content tree. The trace
  contained 176 `SelectItem` executions, and the model-picker slot consumed
  about 127 ms of inclusive development-mode span time. This was substantially
  more work than Tiptap in the same sample.

`thread.selectedModel$` already resolves to a primitive model identifier, but
the composer model hook of the time immediately wrapped it in new
`modelSelection` and `modelPicker` objects. That responsibility now sits on the
composer signals themselves: `ComposerModelPickerSlotBase` reads
`signals.model.modelSelection$` directly. The composer entry point — a single
hook at the time, now the `ChatComposer` component in
`turbo/apps/platform/src/views/okou-page/chat-composer.tsx` — also recreates its
event handlers and passes them through every composer leaf. This makes otherwise
unrelated run and message transitions re-execute the closed picker and editor
leaves.

Finally, most of the pre-change commit count came from an intentional animation
policy, not server event volume. `setThinkingIndicatorTextRef$` wrote a new
`thinkingTypewriterFrame$` every `THINKING_TYPEWRITER_INTERVAL_MS` (28 ms), and
`ThinkingIndicator` subscribed to the derived primitive
`displayedThinkingText$`. Primitive equality correctly suppressed identical
strings, but each typewriter frame was a different string. Each render also
allocated new `blockStyle` and `serverThinkingLabel` objects, which propagated
the frame through the waiting-row subtree.

### Result after removing the thinking animations

The typewriter state, 28 ms loop, canvas text measurement, DOM ref command, and
React subscription were removed. A thinking marker now renders its full text in
one update. The CSS shimmer, block-pop, and entrance animations were also
removed so the indicator is fully static. Two repeated sends on the same stable
thread produced the first two post-change rows below:

| Sample                           | First-second commits | Five-second commits | Last measured commit |
| -------------------------------- | -------------------: | ------------------: | -------------------: |
| Without typewriter, first run    |                   11 |                  29 |              3.310 s |
| Without typewriter, traced run   |                   11 |                  24 |              3.281 s |
| Without any React thinking loops |                   22 |                  24 |              1.461 s |

The matching pre-change sample had 62 commits in five seconds. The fixed 28 ms
cadence disappeared completely. The remaining count still varies with remote
event timing.

The first implementation pass exposed one remaining periodic update at about
3.3 seconds: `runPhraseLoop$` still rotated the fallback phrase and refreshed a
done phrase every 3.5 seconds. That loop was also removed. Each thread now picks
one stable fallback phrase, while the done phrase is derived from messages and
subscribed only by the finished row. In the final trace, all React work ended by
1.461 seconds and no timer-driven `ThinkingIndicator` update remained.

A later follow-up restored the thinking text typewriter at a 100 ms interval,
along with the CSS shimmer, block-pop, and entrance animations. The fallback
phrase remains stable rather than rotating. The measurements in this section
therefore document the fully static baseline, not the current animation policy.

The phrase "first-second commits" is only a time bucket, not a causal phase. In
the traced run, all initial local work finished within 301 ms, followed by no
labelled scheduler update until 1.194 seconds. In another run, a remote thinking
event arrived at 0.91 seconds and was counted in the first-second bucket. Split
profiles into an initial local burst and later remote events instead of treating
one second as a stable boundary.

The 11 commits in the initial local burst had ten labelled scheduler update
initiators:

| Update initiator              | Count | Immediate cause                                                      |
| ----------------------------- | ----: | -------------------------------------------------------------------- |
| `ChatThreadComposer`          |     3 | Send loadable, run state, and composer-derived lifecycle transitions |
| `WorkflowComposerPlaceholder` |     1 | The submitted draft was cleared                                      |
| `ThinkingIndicator`           |     1 | The optimistic user/run projection made the indicator visible        |
| `ChatThreadHeader`            |     1 | A new `threadMeta$` object reached the header                        |
| `AssistantBubbleAvatar`       |     1 | The newly mounted waiting row resolved its async `agentId$`          |
| `MobileTopBar`                |     1 | A new `mobileBreadcrumb$` object reached the hidden mobile header    |
| `ChatThreadItem`              |     1 | The current sidebar row gained its active-run state                  |
| `AgentListDialog`             |     1 | The closed dialog observed changing thread-list data                 |

One root commit had no separate scheduler label. Several labelled transitions
are user-visible and valid, but their descendant work is still much broader
than necessary:

- The composer leaves executed five times in the first 500 ms.
  `uploadsReady` changed `true -> false -> true`, while four of five Tiptap
  executions changed only callback identities. The closed model picker also
  executed five times, expanded 80 `SelectItem` executions, and occupied about
  70 ms of inclusive component span time; Tiptap occupied about 1.8 ms.
- `ChatThreadMessagesMain` and `ChatThreadMessageGroups` each executed three
  times. Four old user rows and four old assistant rows received new, deeply
  equal `blocks` arrays during the initial burst.
- The visible sidebar container still did not execute. Its one row update was
  semantic; the closed dialog and hidden mobile header were avoidable work.

After the initial burst in the intermediate trace, there were four
`ChatThreadContent` updates, one composer update, two closed-dialog updates, one
sidebar-row update, one mobile-header update, and the periodic phrase-loop
update that prompted the second cleanup.

The final trace contained 20 labelled scheduler updates in total: six from the
closed `AgentListDialog`, four from `ChatThreadContent`, three from
`ChatThreadItem`, three from `ChatThreadComposer`, and one each from
`WorkflowComposerPlaceholder`, the initial `ThinkingIndicator`,
`AssistantBubbleAvatar`, and the hidden `MobileTopBar`. There were no
per-character, phrase-rotation, or delayed done-phrase React updates.

### Result after moving subscriptions to leaf components

The next pass removed the object-level `threadMeta$` subscription from the
header, made title fields and server settlement primitive async computed values,
and changed `ChatThreadContent` into a subscription-free layout shell. The
message pane now subscribes to the rendered group window and server settlement,
while a dedicated thinking leaf subscribes to the complete group list. The
composer is a sibling of that message pane, so message projection updates no
longer execute the composer subtree through their parent.

The attachment upload summary object was also replaced with an async readiness
primitive. React observes only `useLoadableState(attachmentUploadsReady$)`.
With no attachments the computed returns synchronously, so clearing an already
empty draft does not create a false `loading -> hasData` transition.

A real-browser trace of the same send shape showed the following component
execution counts. The runs had different remote event timings and message
history lengths, so the table is evidence about subtree isolation rather than
a controlled comparison of total render cost:

| Component or subtree       | Earlier final trace | Leaf-subscription trace |
| -------------------------- | ------------------: | ----------------------: |
| `TiptapWorkflowComposer`   |                  11 |                       4 |
| `ComposerModelPickerSlot`  |                  11 |                       4 |
| `ChatThreadMessagesMain`   |                   8 |                       3 |
| `ChatThreadMessageGroups`  |                   8 |                       3 |
| Closed-picker `SelectItem` |                 176 |                       0 |

The closed picker reached zero items by mounting
`ModelFirstModelPickerContent` only when a controlled picker is open. The
trigger and its primitive model subscriptions remain mounted, so opening and
changing the model retain their normal behavior. Uncontrolled picker callers
keep the previous mounting behavior.

The 2026-07-12 leaf-subscription sample recorded 23 root commits and about 192
ms of cumulative development-mode `actualDuration`. All commits ended within
1.631 seconds of the first send-triggered commit. Its 18 labelled scheduler
initiators were:

| Update initiator              | Count |
| ----------------------------- | ----: |
| Closed `AgentListDialog`      |     4 |
| `ChatThreadMessagesPane`      |     3 |
| `ChatThreadComposer`          |     3 |
| `ChatThreadItem`              |     2 |
| Hidden `MobileTopBar`         |     2 |
| `ChatThreadThinkingIndicator` |     1 |
| Initial `ThinkingIndicator`   |     1 |
| `WorkflowComposerPlaceholder` |     1 |
| `AssistantBubbleAvatar`       |     1 |

`ChatThreadContent` and `ChatThreadHeader` were absent from the scheduler
update sources. The three composer updates are direct subscriptions for the
send and run lifecycle; message-list updates no longer cause additional
composer executions. The message pane and thinking leaf still update when their
different semantic projections change, which is expected.

### Result after isolating the closed dialog and sidebar window (2026-07-13)

The next pass stopped mounting the signal-consuming `AgentListDialog` body
while the dialog is closed. The main chat list also stopped subscribing to the
complete thread collection in React. Its layout reads a primitive item count,
and the row container subscribes only to the current virtual window.

The local development trace used an established thread with five rendered
sidebar rows and a closed agent dialog. The prompt was entered before resetting
the counters. Profiling stopped only after the run reached `completed`, the
expected assistant text was visible, and the composer was idle.

The immediate pre-isolation and post-isolation traced sends had the same
backend shape: four runner telemetry events (`last_event_sequence = 3`), six
persisted message projections including usage, and two `sort_touched` thread
events. The post-isolation repeat also had four telemetry events and two sort
events, but no usage projection arrived. Message history was longer in the
post-isolation samples, so component span duration and total descendant work
are not direct cost comparisons.

| Field                                   |                                   Before sidebar isolation |                                   After sidebar isolation | Root-counter repeat |
| --------------------------------------- | ---------------------------------------------------------: | --------------------------------------------------------: | ------------------: |
| Local trace artifact                    | `tmp/react-commit/chat-send-semantic-leaves-20260713.json` | `tmp/react-commit/chat-send-sidebar-window-20260713.json` |        Not recorded |
| Attribution window                      |                                                    5.700 s |                                                   5.053 s |        Not recorded |
| Root commits                            |                                                         46 |                                                        35 |                  40 |
| Cumulative development `actualDuration` |                                               Not recorded |                                                  370.1 ms |            373.7 ms |
| Scheduler `Update` / `Cascading Update` |                                                     26 / 8 |                                                    17 / 4 |        Not recorded |
| Runner telemetry events                 |                                                          4 |                                                         4 |                   4 |
| Persisted message projection rows       |                                                          6 |                                                         6 |                   5 |
| `sort_touched` thread events            |                                                          2 |                                                         2 |                   2 |

The root count fell from 46 to 35 in the matched traced send. The repeat
recorded 40, so the current observation is a 35-40 range rather than a fixed
benchmark. The two post-isolation samples had nearly identical cumulative
`actualDuration` despite the five-commit difference, which is another reason
not to use commit count alone as a cost metric.

The scheduler attribution changed as follows:

| Direct update source or region                                                   | Before |  After |
| -------------------------------------------------------------------------------- | -----: | -----: |
| Closed `AgentListDialog`                                                         |     14 |      0 |
| `ChatThreadsContent`, `ExpandedChatThreadsContent`, and `VirtualizedChatThreads` |      0 |      0 |
| `ChatThreadItem`                                                                 |      2 |      4 |
| `PinnedAgentListSection`                                                         |      0 |      4 |
| Other sidebar leaves                                                             |      1 |      2 |
| Message and thinking leaves                                                      |     10 |      6 |
| Composer leaves                                                                  |      6 |      5 |
| Shared overlay state                                                             |      1 |      0 |
| **Total labelled initiators**                                                    | **34** | **21** |

These are scheduler attribution events, not root commits. The closed dialog
result is nevertheless exact: its fourteen direct initiators and four
component spans both fell to zero because the body was no longer mounted.
`ChatThreadsContent` and both virtual-list containers remained absent from the
update sources.

The visible row boundary still needs work. `ChatThreadItemLink` executed 25
times in both traces. Only two executions reflected a real
`indicatorState: null -> running -> null` transition; the other 23 received a
referentially new but deeply equal state object. Stable keys preserved row
identity, but each visible row still subscribes to the complete draft, unread,
and active thread-ID sets. A real membership change therefore wakes all five
rows even though only one row changes visually. Collection equality suppresses
equivalent replacement sets; it cannot isolate a real set transition to the
affected row. Per-thread boolean computed values are the appropriate next
subscription boundary.

This five-row sample also cannot demonstrate the offscreen benefit of the
virtual-window projection because the complete local list fit in the rendered
window. A follow-up with more threads than the visible window should verify
that an offscreen-only metadata change produces no React work and that a
one-row scroll boundary updates the window once.

One independent sidebar source remained: `PinnedAgentListSection` scheduled
four external-store updates but had no same-name component span. Its
`unreadAgentIds$` subscription currently has no set equality, making it the
leading candidate when thread-list events recreate an equivalent set.
Attribute that signal directly before changing the component because the
section also observes route, agent, feature-switch, and pinned-agent data.

The message projection remains the largest descendant fan-out:

| Component                   | Before executions | After executions |
| --------------------------- | ----------------: | ---------------: |
| `ChatThreadMessageGroups`   |                 7 |                7 |
| `PagedGroupRow`             |                68 |               68 |
| `PagedUserMessage`          |                34 |               34 |
| `PagedAssistantMessageItem` |                61 |              122 |
| `TiptapWorkflowComposer`    |                 4 |                4 |
| `ComposerModelPickerSlot`   |                 4 |                4 |
| Closed-picker `SelectItem`  |                 0 |                0 |

Total component executions rose from 3,502 to 3,817 while the inclusive span
workload index fell from 3,986.6 ms to 2,932.7 ms. Neither number is wall time:
the extra executions came mainly from the longer assistant history and its
usage-popover descendants, not from the isolated sidebar containers.

All seven message-group executions rebuilt the complete group projection and
propagated new arrays into old rows. The doubled assistant-row count reflects
the longer message history, not a controlled regression, but it makes the cost
of missing structural sharing more visible. The composer stayed isolated at
four executions, and the closed model picker continued to create no
`SelectItem` components.

### Result after membership-specific sidebar equality (2026-07-13)

The three row subscriptions already used `equalSets`, but that comparison was
too broad. It correctly suppressed a new Set with identical contents, while a
real membership change for any thread still notified every visible row. Each
row only renders `.has(threadId)`, so the equality functions now compare that
single membership instead. `PinnedAgentListSection` also now applies
`equalSets` to `unreadAgentIds$`, which refetches into a new Set after each
unread-state invalidation.

The follow-up trace used the same established thread and five rendered rows.
It reached `completed` with four runner telemetry events, five persisted
message projections without usage, and two `sort_touched` events. The root hook
recorded 35 commits and 300.3 ms of cumulative development `actualDuration`.
Those totals are descriptive because remote event timing still varied.

The sidebar result is more direct:

| Attribution                                       | Before membership equality | After membership equality |
| ------------------------------------------------- | -------------------------: | ------------------------: |
| `ChatThreadItemLink` executions                   |                         25 |                         5 |
| Deeply equal row-state executions                 |                         23 |                         3 |
| Semantic `null -> running -> null` executions     |                          2 |                         2 |
| `PinnedAgentListSection` scheduler initiators     |                          4 |                         0 |
| Closed `AgentListDialog` initiators               |                          0 |                         0 |
| Chat-list and virtual-window container initiators |                          0 |                         0 |

The row-level collection subscriptions are now hidden behind
`useThreadDraft`, `useThreadUnread`, and `useThreadActiveRun`. Each hook keeps
the shared ccstate Set but compares only membership for its own thread ID, so
callers cannot accidentally consume the unstable full collection. Running
state now has one source: `sidebarActiveThreadIds$`. The legacy
`ChatThreadListItem.running` projection, its adapter computed, and its schema
were removed; the virtual window exposes only the row fields React renders.

The remaining five row executions all belonged to the current row rather than
five rows executing as a batch. Three still produced the same final state,
most likely because separate draft, unread, active, or pane transitions can
change while the final indicator precedence stays unchanged. A single
primitive `indicatorState` projection is the next boundary only if those three
executions remain material.

### Composer fan-in after the sidebar fixes (2026-07-13)

The same trace showed that the editor itself is not the composer bottleneck.
`TiptapWorkflowComposer` executed five times and consumed 2.8 ms of inclusive
component span time. The larger issue is that `ChatThreadComposer` pulled the
whole composer into the same Fiber, so send, queue, model, connector,
attachment, dialog, and editor subscriptions all shared one render boundary.
That fan-in has since been split: `ChatThreadComposer` renders
`ChatComposer`, which renders `ComposerSurface`, and each concern now
subscribes inside its own slot component — `ComposerInputSlot`,
`ComposerModelPickerSlot`, `ComposerConnectorsSlot`, `ComposerAttachments`,
and `ComposerSendControl`.

Five full composer batches executed 662 components inside the `Card` subtree:

| Batch                          | Semantic result            | Component executions | `Card` inclusive span |
| ------------------------------ | -------------------------- | -------------------: | --------------------: |
| Send starts                    | `sending: false -> true`   |                  134 |               18.2 ms |
| Run projection starts          | `sending` remains `true`   |                  131 |               10.4 ms |
| Send command resolves          | `sending` remains `true`   |                  134 |               10.3 ms |
| Run finishes                   | `sending: true -> false`   |                  131 |                7.9 ms |
| Later subscribed value settles | No visible composer change |                  132 |                7.3 ms |

Only the first and fourth batches changed the semantic sending state. The other
three accounted for 397 component executions and 28.0 ms of `Card` span time.
This matches the React-side aggregation
`sending = !allFinished || sendLoading`: the two inputs transition separately
even when the resulting boolean does not change.

Every batch also recreated closure or object props throughout the subtree.
Notable repeated leaves were `ConnectorsPopoverButton` (five executions,
12.6 ms), `ComposerModelPickerSlot` (five, 9.1 ms), and
`TiptapWorkflowComposer` (five, 2.8 ms). Stabilizing callbacks alone would not
stop these executions without memoization; the useful change is to move each
subscription into the leaf that consumes it and expose primitive semantic
signals such as composer sending state.

There are two narrower follow-ups:

- `TiptapWorkflowComposer` uses an inline hidden-element ref to write workflow
  names and event handlers after every render. `setWorkflowNames$` dispatches a
  ProseMirror transaction whenever the editor is initialized, without checking
  whether the names changed. Move runtime configuration out of the render/ref
  path; at minimum, equal workflow names must not dispatch a transaction.
- A direct `ModelFirstModelPicker` store update executed 21 closed trigger-tree
  components without a semantic prop change. Its policy and billing loadables
  should expose the primitive state actually rendered by the closed picker.

### Prioritized follow-up

1. Preserve enriched message and block identity for unchanged raw message
   objects. Use structural sharing at the transcript projection boundary
   instead of a recursive deep-equality check in React.
2. Split composer subscriptions into signal-connected leaves and expose one
   primitive semantic sending state. Do not treat `useCallback` or deep prop
   equality as a substitute for the subscription boundary.
3. Remove the Tiptap render/ref-driven runtime configuration and prevent equal
   workflow names from dispatching a ProseMirror transaction.
4. Narrow the closed model picker's policy and billing subscriptions to the
   primitive state rendered by its trigger.
5. If the remaining three sidebar row executions are material, derive one
   primitive indicator state per stable row signal instead of creating a
   computed inside React.
6. Verify virtual-window isolation with more threads than fit in the rendered
   window, including offscreen metadata changes and a one-row scroll boundary.
7. Remove object-level subscriptions from `MobileTopBar` and other leaves that
   render primitive fields.
8. Repeat the measurement with a fixed mocked event sequence that reaches a
   terminal state. Compare commits per event and retain separate counts for the
   initial send transition, stream events, and settlement.

## Memory Leaks Are a Separate Investigation

Low commit counts do not prove that thread switching is leak-free. A leaked
subscription can remain dormant and produce no commits until a later update.

For memory-leak analysis, repeatedly switch between the same threads and check:

- ccstate watcher/subscription counts return to a stable baseline;
- aborted page and thread signals release polling loops;
- detached promises finish during teardown;
- DOM node and fiber counts do not grow monotonically;
- heap snapshots do not retain old thread signal factories or message trees.

Treat commit profiling and heap/subscription profiling as complementary tools.

## Reporting Checklist

Every React performance report should include:

- route and user action;
- development or production build;
- visible row/message counts;
- warm-up and measurement boundaries;
- stream/event count and terminal state;
- total commits and cumulative duration;
- execution counts by page region;
- known sources of nondeterminism;
- before/after code revision;
- behavior tests and browser verification performed.

The goal is not zero commits. The goal is for every commit and every component
execution to correspond to a semantic value that the user can observe or that
the UI genuinely needs.
