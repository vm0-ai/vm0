# Chat Cards

## Overview

A chat card turns a specially recognized link inside a `ChatMessage` into a
rich, interactive React surface. The message remains the transport: an agent or
another producer can emit a normal URL, Markdown link, or relative platform
path, and the platform upgrades that link into a typed card when its path
matches a supported pattern.

The core pipeline is:

```text
ChatMessage content
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
https://app.vm0.ai/agents/agent-123/permissions?ref=slack&permission=messages.write

[Review permission](https://app.vm0.ai/agents/agent-123/permissions?ref=slack&permission=messages.write)

/computer-use/authorize/request-token
```

Absolute URLs must use an allowed VM0 platform origin. Relative paths resolve
against the configured platform origin. A URL becomes a card only when its path
and required parameters match a card parser exactly. An unrecognized or invalid
link remains ordinary Markdown.

Current link-backed card patterns include:

- `/connectors/:connectorRef/connect` and
  `/connectors/:connectorRef/authorize`
- `/connectors/custom/proposal?p=...`
- `/agents/:agentId/permissions?...`
- `/computer-use/authorize/:requestToken`
- `/?settings=billing&billingView=plans`
- `/mail/drafts/:vm0DraftId`
- platform artifact URLs such as `/f/...` and `/artifacts/...`, plus hosted
  site URLs that support an inline preview

The rich billing-plan card is guarded by
`FeatureSwitchKey.PlanUpgradeGuidance`. When the switch is disabled, the
recognized URL remains a standard link instead of rendering the upgrade card.

A path such as `/chats/:threadId` can use the same design when a chat-thread
card is introduced: add an exact parser for the path, derive a canonical
resource key, define the card's signals and registry, and add its render case.
The generic URL parser must not treat every `/chats/*` link as a card before
that card type exists.

## Data Flow

### 1. Parse content into pure descriptors

`parseMessageBodyBlocks` extracts renderable content from a `PagedChatMessage`
and passes it to `parseBodyBlocks`. The parser separates normal Markdown from
recognized cards.

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

`BodyRenderBlockView` selects the component by the block's discriminated
`type` and passes the signals object directly:

```tsx
case "permission-action": {
  return <PermissionActionCard signals={block.signals} />;
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

produces a descriptor containing the connector reference, agent ID, and
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

### Provider-backed resource: Gmail draft

A vm0 mail link matches `/mail/drafts/:vm0DraftId`. The vm0 UUID is the stable
resource key; Gmail draft, thread, and message IDs remain provider metadata and
are not inferred from Gmail Web URLs. The thread-scoped signals read the Gmail
draft through one reloadable Zero Mail API computed. Repeated card occurrences
and the detail sidebar share that computed, while Send and Delete invalidate it
after their mutations complete.

The fixed-height card displays the Gmail identity, subject, sender, and
`Draft`, `Sent`, or `Deleted` status. Draft and Sent cards open the shared right
sidebar surface. Deleted cards retain their summary but are not interactive.

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
   loading and mutation behavior, and invalid links falling back to Markdown.

Do not create signals in the parser, transcript computed, or React component.
Do not use a root-lifetime URL cache. Do not add a card to a shared aggregate
registry.

## Relevant Implementation Files

- `turbo/apps/platform/src/signals/chat-page/chat-message-body-blocks.ts`
- `turbo/apps/platform/src/signals/chat-page/parse-body-blocks.ts`
- `turbo/apps/platform/src/signals/chat-page/create-chat-thread.ts`
- `turbo/apps/platform/src/signals/chat-page/artifact-card-signals.ts`
- `turbo/apps/platform/src/signals/chat-page/connector-action-block.ts`
- `turbo/apps/platform/src/signals/chat-page/permission-card-signals.ts`
- `turbo/apps/platform/src/signals/chat-page/mail-draft.ts`
- `turbo/apps/platform/src/signals/chat-page/platform-action-url.ts`
- `turbo/apps/platform/src/signals/chat-page/computer-use-authorization-block.ts`
- `turbo/apps/platform/src/signals/chat-page/plan-upgrade-block.ts`
- `turbo/apps/platform/src/views/zero-page/zero-chat-thread-page.tsx`
