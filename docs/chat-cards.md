# Chat Cards

## Overview

A chat card turns a specially recognized link inside a `ChatEvent` into a
rich, interactive React surface. The message remains the transport: an agent or
another producer can emit a normal URL, Markdown link, or relative platform
path, and the platform upgrades that link into a typed card when its path
matches a supported pattern.

The core pipeline is:

```text
ChatEvent content
  -> recognize a trusted link and parse a typed descriptor
  -> derive a stable resource key
  -> register signals at the message write/command boundary
  -> attach the signals object to a render block
  -> pass the signals object to the matching React component
```

This design keeps message content portable while allowing the platform to add
loading states, live data, actions, and other rich interaction without putting
state creation inside React render.

## Recognized Link Shapes

The body parser accepts platform links in common message forms:

```markdown
https://app.vm0.ai/agents/c0000000-0000-4000-a000-000000000001/permissions?connectorSlug=slack&permission=messages.write

[Review permission](https://app.vm0.ai/agents/c0000000-0000-4000-a000-000000000001/permissions?connectorSlug=slack&permission=messages.write)

/computer-use/authorize/request-token
```

Absolute URLs must use an allowed VM0 platform origin. Relative paths resolve
against the configured platform origin. A URL becomes a card only when its path
and required parameters match a card parser exactly. Unrecognized links remain
ordinary Markdown. Recognized connector and permission actions are different:
their URL targets are untrusted claims and must match the authenticated chat
thread's agent and optional callback thread. A mismatch renders an inert
unavailable card instead of a link or command.

Current link-backed card patterns include:

- `/connectors/:connectorSlug/connect` and
  `/connectors/:connectorSlug/authorize`
- `/connectors/custom/proposal?p=...`
- `/agents/:agentId/permissions?...`
- `/agents/:agentId/connector-accounts/:connectionId/select?...`
- `/computer-use/authorize/:requestToken`
- `/?settings=billing&billingView=plans`
- `/mail/drafts/:vm0DraftId`
- `/browsers/:threadId`
- platform artifact URLs such as legacy `/f/...` and `/artifacts/.../.../...`
  paths, plus hosted site URLs that support an inline preview. Flat V2 artifact
  paths such as `/artifacts/97ngzkxdyn.mp4` require a complete URL with an
  allowed VM0 origin.

Recognized billing-plan links render as rich upgrade cards.

A path such as `/chats/:threadId` can use the same design when a chat-thread
card is introduced: add an exact parser for the path, derive a canonical
resource key, define the card's signals and registry, and add its render case.
The generic URL parser must not treat every `/chats/*` link as a card before
that card type exists.

## Data Flow

### 1. Parse content into pure descriptors

`chatEventTreePlan` extracts renderable content from a `ChatEvent` and passes it
to `eventBodyPlan`. The parser separates normal Markdown from recognized cards.
The current thread ID and server-derived primary agent ID are supplied as
immutable planning context. Parsing is synchronous and does not query an API or
database.

A recognized card is first represented as a pure `ParsedBodyBlock`:

```ts
type ParsedPermissionBlock = {
  type: "permission-action";
  resourceKey: string;
  descriptor: PermissionActionDescriptor;
};
```

The descriptor contains parsed domain data only. It must not create `state`,
`computed`, `command`, subscriptions, or other runtime resources. This keeps
parsing deterministic and safe to run for persistent, IndexedDB, realtime, and
optimistic messages.

Connector and permission descriptors are created only after their URL agent ID
matches the context agent ID and any callback contains both a non-empty prompt
and the context thread ID. Valid descriptors use the context identities rather
than copying URL claims. Recognized context-invalid actions produce only a
static unavailable descriptor, so they register no action signals and cannot
fall back to a clickable Markdown slot.

### 2. Derive a stable resource key

Every card type defines the identity of the resource it represents. Examples
include an artifact URL, a normalized permission URL, or a computer-use request
path.

The resource key has two jobs:

- repeated cards for the same resource reuse one signals object within a
  thread;
- the render layer combines it with the card type and occurrence index to
  produce a stable React key for each rendered occurrence.

The key should represent domain identity, not message identity. URL forms that
refer to the same resource should be normalized before they are used as a key.

### 3. Register signals before transcript rendering

Each chat thread creates one independent registry for each card type. When a
message enters the transcript through a command or another write boundary,
`create-chat-thread.ts` dispatches each parsed block to its matching registry.

Conceptually, a registry performs:

```ts
interface PermissionCardSignalsRegistry {
  register(descriptor: PermissionActionDescriptor): PermissionSignals;
  resolve(resourceKey: string): PermissionSignals;
}
```

`register` creates the signals object once or returns the existing object for
the resource key. `resolve` only returns a previously registered object and
fails if registration was skipped.

Persistent messages, IndexedDB messages, realtime messages, initial optimistic
messages, and newly appended optimistic messages all register their card
signals before transcript projection. Transcript recomputation therefore does
not allocate new signal identities.

### 4. Produce a render block

Registration replaces the descriptor with the stable signals object:

```ts
type PermissionRenderBlock = {
  type: "permission-action";
  resourceKey: string;
  signals: PermissionSignals;
};
```

`create-chat-thread.ts` contains the body-block type dispatch, but it does not
own an aggregate card registry. Artifact, connector, custom connector,
permission, and computer-use authorization cards each keep their own typed
registry and resource model.

### 5. Render the matching React component

`MarkdownCardView` in
`turbo/apps/platform/src/views/okou-page/chat-body-cards.tsx` is the single
dispatch the markdown renderer uses for `data.card` nodes. It selects the
component by the card's discriminated `kind` and passes the signals object
directly:

```tsx
case "permission-action": {
  return <PermissionActionCard signals={card.signals} />;
}
```

The component reads computed values with ccstate React hooks and invokes
commands in response to user events. It does not parse the original URL, look
up a registry, or create signals during render.

## Registry Ownership and Lifetime

Card registries are owned by the chat thread that created them. Their maps are
not module-level caches and are released with the thread.

This gives the model the following properties:

- two occurrences of the same resource in one thread share state;
- separate threads have isolated signal identities;
- transcript recomputation does not cause resubscription or reload flicker;
- registry growth is bounded by the resources referenced by the owning thread;
- each card type can evolve its descriptor and signals without forcing other
  card types into a shared data structure.

The registry implementations may share small stateless map helpers, but there
is no common registry object or universal card signals interface.

## Examples

### Simple: computer-use authorization

A computer-use authorization link matches:

```text
/computer-use/authorize/:requestToken
```

Its descriptor contains the request token, original URL, and normalized `href`.
The current signals type is the descriptor itself because the card does not
need additional ccstate resources:

```ts
type ComputerUseAuthorizationSignals = ComputerUseAuthorizationDescriptor;
```

The registry still provides stable resource identity and keeps this card on the
same lifecycle path as more stateful cards.

### Read-only asynchronous data: artifact preview

An artifact URL produces an `ArtifactDescriptor` with `filename`, `url`, and
`kind`. Image, video, audio, PDF, and HTML previews can render directly from
that descriptor.

Text and JSON previews add an asynchronous computed resource:

```ts
interface ArtifactSignals extends ArtifactDescriptor {
  readonly text$?: Computed<Promise<string>>;
}
```

The component receives `text$`, renders its loadable state, and displays the
resolved preview. Repeated previews of the same artifact URL share the same
computed identity within the thread.

### Stateful action: connector card

A connector link such as:

```text
/connectors/slack/connect?agentId=agent-123
```

produces a descriptor containing the connector slug, agent ID, and
original URL. Its signals combine several reactive reads and an action:

```ts
interface ConnectorSignals extends ConnectorActionDescriptor {
  catalogItem$: Computed<Promise<PublicConnectorCatalogStatusItem | null>>;
  available$: Computed<Promise<boolean>>;
  connected$: Computed<Promise<boolean>>;
  authorized$: Computed<Promise<boolean>>;
  complete$: Computed<Promise<boolean>>;
  activate$: Command<Promise<void>, [AbortSignal]>;
}
```

The React card can show whether the connector is available, connected, and
authorized, then invoke `activate$` from a user action. All occurrences of that
connector `resourceKey` in the thread observe the same computed graph.

### Complex shared data: permission card

A permission URL matches `/agents/:agentId/permissions` and encodes the
connector, permission, action, optional request metadata, and expiration in its
query parameters.

The resulting signals include:

- `agent$` for agent presentation data;
- `grants$` for the user's current permission grants;
- `metadata$` for the connector permission catalog;
- normalized descriptor fields used to apply the allow or deny action.

Permission changes can arrive from another card or another product surface. A
user-level realtime event invalidates the shared grants source, so mounted
permission cards refresh without replacing their signals identities.

### Confirmed action: connector account switch

A connector account switch URL matches:

```text
/agents/:agentId/connector-accounts/:connectionId/select
  ?kind=builtin
  &connectorSlug=github
  &threadId=:threadId
  &callbackPrompt=:prompt
```

Custom connectors use `kind=custom` and `customConnectorId` instead of
`connectorSlug`. The parser requires exactly one well-formed target, the chat's
server-derived agent ID, and a callback bound to the current thread. These URL
values are untrusted claims. The card reads the exact account from the API and
uses only the live account metadata for presentation; a missing, cross-owner,
or wrong-target account renders an inert unavailable card.

Confirmation writes the exact account selection to the current thread before
starting the callback round. The selection endpoint resolves the externally
managed account reference again, so an account that was removed, reconnected,
or otherwise became invalid after the card loaded fails closed. A failed write
does not run the callback. A successful write updates only the sparse thread
override used by future runs; it does not mutate the global default or the run
that produced the card.

Repeated occurrences of the same action share one signals object. The card also
reads the composer's shared connector-account preference state, so local
confirmation and thread-detail realtime events update every mounted occurrence.
The action is gated by `ConnectorAccounts`; older frontends that do not know the
card continue to render the emitted Markdown link.

### Provider-backed resource: Gmail draft

A vm0 mail link matches `/mail/drafts/:vm0DraftId`. The vm0 UUID is the stable
resource key; Gmail draft, thread, and message IDs remain provider metadata and
are not inferred from Gmail Web URLs. The thread-scoped signals read the Gmail
draft through one reloadable Okou Mail API computed. Repeated card occurrences
and the detail sidebar share that computed, while Send and Delete invalidate it
after their mutations complete.

The fixed-height card displays the Gmail identity, subject, sender, and
`Draft`, `Sent`, or `Deleted` status. Draft and Sent cards open the shared right
sidebar surface. Deleted cards retain their summary but are not interactive.

### Provider-backed live resource: managed browser

A managed-browser link matches `/browsers/:threadId`. The chat thread ID is the
canonical resource key: each thread owns at most one logical browser, and every
provider instance for that browser carries the same thread attribution. The card
never accepts a Browser Use `liveUrl` or CDP URL from message content. Instead,
its thread-scoped computed reads the browser through
`/api/chat-threads/:threadId/browser`. A copied card therefore cannot resolve a
browser owned by a different thread.

The message card follows the presentation and website preview treatment. It
shows a `Cloud browser` header with a simplified `Live` or `Stopped` status,
then a `16:10` static preview of the latest foreground tab at up to `400px`
wide. The preview fills its frame and stays aligned to the top, with a
placeholder until the first screenshot is available. The whole card opens the
shared right sidebar surface; it does not show browser-specific metadata or
charged credits. The live page remains in that sidebar and in the full-page
route rather than in the message stream, because it resizes as it loads and
would otherwise shift the transcript.

A provider instance outlives the run that opened it. Every terminal run callback
only extends the instance's idle lease, so the user can keep working in the same
window and a later run in the same thread attaches to it with
`okou browser use`. The reconciler reclaims an instance once its lease expires,
its hard timeout is reached, or the provider ends it. Deleting a chat thread
also reclaims its browser. While the sidebar or full-page viewer is open
and its page is visible, it refreshes the lease on a timer; the CLI can do the
same with `okou browser lease`. Each lease is a fixed window from now and cannot
be stacked. The once-per-minute reconciler captures the foreground tab of each
healthy active browser as a `640px`-wide WebP, preserves its aspect ratio, and
replaces the thread's previous immutable preview object. Viewer lease
heartbeats do not capture screenshots, and screenshot failure does not affect
the browser lease.

Starting or resuming appends a payload-free `browser.open` chat event; clicking
the sidebar close button appends a payload-free `browser.close` event without
stopping the provider instance. Automatic reclamation for an existing thread
also appends `browser.close` without inspecting the current sidebar state. The
frontend supplies each mutation's event UUID so it can optimistically
project the same event without duplicating it when the server response or
realtime delivery arrives. Folding these events in order yields the thread's
browser sidebar state. Opening a thread waits for the authoritative initial
event page before using that projection to auto-open the sidebar, so stale
IndexedDB events cannot override a later server close. A `browser.open`
projection opens the sidebar only when no other utility sidebar is already open;
a later `browser.close` projection does not auto-open it. The browser icon in
the thread header remains available in either state, and both a never-created
browser and a non-live browser keep the Start action. When a screenshot exists,
the suspended sidebar reuses it at full width and top-aligns it beneath a
half-transparent blurred mask, so the small preview fills the available surface
without being presented as a live browser.

Once an instance is reclaimed, the viewer keeps the stable
`/browsers/:threadId` link. Its Start action, and `okou browser use` in a later
run, create a new provider instance from the thread's saved profile: cookies and
storage come back, and saved HTTP(S) tab URLs are reopened on a best-effort
basis. Provider state changes publish a user-scoped realtime event carrying the
canonical thread ID so the card, sidebar, and full-page viewer refresh together.

Each thread owns an isolated login profile. Multiple threads may run provider
instances in parallel up to the organization's run concurrency entitlement.
Before starting another provider instance, the API reclaims the active browser
with the earliest idle lease until a slot is available. Provider stop requests
are best-effort and do not delay the new start. The API serializes each thread's
first profile creation so concurrent first use still creates one provider
profile for that thread.

The same universal link also has an authenticated full-page route. The browser
provider's CDP URL is reserved for the Okou CLI to connect `agent-browser` and
is never returned by the card read, lease, or resume endpoints, nor printed in
CLI output.

## Adding a Card Type

When adding a new link-backed card:

1. Define the accepted origins, exact path pattern, required parameters, and
   parser validation.
2. Define a pure descriptor and canonical resource key.
3. Add a distinct parsed-block and render-block variant.
4. Define the card-specific signals interface and factory.
5. Create an independent, thread-scoped registry for that card type.
6. Add the registration and resolution cases to the body-block dispatcher.
7. Add the React component case and pass only the typed signals object.
8. Cover absolute, relative, and Markdown link forms that the card accepts.
9. Test repeated-resource sharing, persistent and optimistic message paths,
   loading and mutation behavior. Define explicitly whether invalid recognized
   links remain Markdown or render inertly; mutating actions must fail closed.

Do not create signals in the parser, transcript computed, or React component.
Do not use a root-lifetime URL cache. Do not add a card to a shared aggregate
registry.

## Relevant Implementation Files

- `turbo/apps/platform/src/signals/chat-page/chat-event-body-blocks.ts`
- `turbo/apps/platform/src/signals/chat-page/chat-action-context.ts`
- `turbo/apps/platform/src/signals/chat-page/parse-body-blocks.ts`
- `turbo/apps/platform/src/signals/chat-page/create-chat-thread.ts`
- `turbo/apps/platform/src/signals/chat-page/artifact-card-signals.ts`
- `turbo/apps/platform/src/signals/chat-page/connector-action-block.ts`
- `turbo/apps/platform/src/signals/chat-page/connector-account-action-block.ts`
- `turbo/apps/platform/src/signals/chat-page/permission-action-block.ts`
- `turbo/apps/platform/src/signals/chat-page/permission-card-signals.ts`
- `turbo/apps/platform/src/signals/chat-page/mail-draft.ts`
- `turbo/apps/platform/src/signals/chat-page/browser-session-block.ts`
- `turbo/apps/platform/src/signals/chat-page/platform-action-url.ts`
- `turbo/apps/platform/src/signals/chat-page/computer-use-authorization-block.ts`
- `turbo/apps/platform/src/signals/chat-page/plan-upgrade-block.ts`
- `turbo/apps/platform/src/views/okou-page/chat-thread-page.tsx`
- `turbo/apps/platform/src/views/okou-page/browser-session-card.tsx`
- `turbo/apps/platform/src/views/okou-page/connector-account-action-card.tsx`
- `turbo/apps/platform/src/views/okou-page/chat-body-cards.tsx`
- `turbo/apps/platform/src/views/browser-session/browser-session-page.tsx`
