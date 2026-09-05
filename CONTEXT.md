# Domain glossary

## Voice draft

A transient ComposerSignals-owned voice-input lifecycle. It captures 16 kHz PCM through AudioWorklet and moves from idle to
recording to transcribing, blocks submission while active, and inserts only the
successful polished text into TipTap at the existing selection before returning
to idle. Recording data, transcription state, and failures are never TipTap
nodes or persisted draft state. Failures show a toast and return directly to
idle so the user can record again.

No-speech provider results and zero-sample recordings complete silently without
inserting text, saving a draft, or showing a toast. The transcription API returns
204 when there is no intelligible speech. Silent chunks are omitted before the
remaining spoken content is polished; entirely silent recordings skip polishing.
Recorder startup failures and cancellation release microphone resources and the
transient submission gate.

_Avoid_: Voice draft block, persisted voice draft, live transcript

## Archived chat history

The durable portion of a chat thread's complete event history that no longer
belongs to the hot event window.

## Hot event window

The most recent 30 days of individual chat events kept available for routine,
latency-sensitive product operations. Thread activity does not extend the age
of an older event.

## Full chat export

A user data export containing the complete logical message history for every
exported chat thread, including archived history and newer messages.

## Archived message selection

Selecting a message from the complete logical chat history after that message
has left the hot event window, subject to the same visibility and revocation
rules as a newer message.

## Automatic session context

The best-effort recent chat context supplied automatically when a new session
starts. It is distinct from explicit retrieval of a thread's complete history.

## Model-originated thinking

Reasoning content emitted by the model or its runtime as part of the durable
assistant transcript.

## Initial progress

Server-generated, transient progress shown while waiting for model output. It
is distinct from model-originated thinking and durable completed-work history.

## Restricted explicit content

Content intended for sexual arousal, sexual depictions involving minors,
graphic violence or gore, or instructions or encouragement for suicide or
self-harm. It excludes non-graphic news, medical, educational, historical,
safety, moderation, and ordinary fictional discussion.

_Avoid_: 18+ content, adult content

# Built-in Generation Failure Context

This context distinguishes provider failures by the stage at which a built-in
generation request is rejected or fails.

## Language

**Output safety block**:
A terminal generation outcome where generated media is withheld because an
output safety check rejected it.
_Avoid_: Input safety rejection, generic generation failure

**Input safety rejection**:
A generation request rejected because its prompt or reference media fails an
input safety check before an acceptable output is available.
_Avoid_: Output safety block, provider outage

# Pi Model Routing Context

This context separates Pi's trusted model metadata from the endpoint and model
identity used for one provider request.

## Language

**Pi catalog model**:
The native Pi provider/model entry used to source model capabilities and limits.
It does not expand product admission and does not have to match a custom
gateway's upstream model identifier.
_Avoid_: Gateway model, requested model

**Pi request model**:
The model identifier sent to the selected provider endpoint. For a custom model
provider gateway, this is the surface's upstream model mapping.
_Avoid_: Catalog model, logical model

**Pi credential header**:
A non-secret header name and value template stored in Pi launch metadata. The
credential is substituted only inside the API first-turn process or the
Sandbox's protected runtime boundary.
_Avoid_: API key header value, stored credential

# Goal Automation Context

This context defines the persistent goal lifecycle used by chat-triggered
workflow automations.

## Language

**Active thread goal**:
A persistent autonomous objective whose current status is `active` for a chat
thread.
_Avoid_: Active run, running automation

**Goal stop**:
The boundary where an active thread goal becomes `paused`, `blocked`, or
`complete`.
_Avoid_: Run finish, goal iteration finish

# Billing Context

The billing context decides whether a purchase can be reviewed and confirmed inside Okou or must continue on a Stripe-hosted page.

## Language

**Saved payment method**:
A Stripe payment method available to an organization through, in priority order, the subscription default, customer invoice default, an attached card, or a legacy default source.
_Avoid_: Bound card, default card

**Operation invoice**:
The invoice produced by confirming the current purchase or subscription change. Unpaid invoices from earlier operations are not part of this decision.
_Avoid_: Customer balance, historical invoice

**Hosted invoice payment**:
The Stripe-hosted invoice page used when an operation invoice remains unpaid after an in-app confirmation attempt.
_Avoid_: Checkout

# Banking Context

This context separates a user's provider-hosted bank connection consent from the narrower access delegated to an Okou agent.

## Language

**Mastercard Data Connect session**:
The Mastercard-hosted flow where a user links a financial institution and consents to Mastercard Open Finance accessing selected bank data.
_Avoid_: Okou bank login, banking agent grant

**Banking connection**:
A reusable link between an Okou user and bank accounts discovered through Mastercard Open Finance. It exists independently of any agent's access.
_Avoid_: Banking agent grant, Data Connect session

**Banking agent grant**:
An Okou authorization that lets one agent read selected connected accounts under explicit operations, duration, and automation rules.
_Avoid_: Bank consent, Mastercard connection

**Banking access request**:
An agent's user-visible request for a banking agent grant, including the purpose for access. The request may first require the user to create or repair a banking connection.
_Avoid_: Banking connection, automatic grant

# Acquisition Attribution Context

This context separates browser conversion delivery from its server-confirmed
source and server-side fallback.

## Language

**Browser conversion**:
A Google Ads website conversion emitted by gtag from an authenticated browser.
_Avoid_: Data Manager upload, server conversion

**Conversion milestone baseline**:
The first server-confirmed milestone snapshot recorded in a browser without
emitting historical conversions.
_Avoid_: Backfill, initial conversion batch

**Data Manager fallback**:
A server-side upload to the same conversion action using the same transaction
ID when browser delivery may be missed.
_Avoid_: Separate conversion, duplicate conversion

# Clerk Satellite Authentication Context

This context separates the app that owns authentication from another app that
shares the same Clerk instance and receives its session.

## Language

**Clerk primary app**:
The app origin where sign-in and sign-up run and where the primary Clerk
session is established.
_Avoid_: Main brand, login tab

**Clerk satellite app**:
A registered app origin that shares the primary app's Clerk instance and
receives synchronized session state.
_Avoid_: Secondary login, separate Clerk instance

**Satellite session sync**:
The Clerk-owned navigation handshake that transfers the active primary-app
session into the current satellite browser context.
_Avoid_: Cookie copy, custom auth redirect

# Chat Image Annotation Context

This context separates an uploaded image, its editable annotation structure,
the rendered derivative shown to agents, and the transient composer session.

## Language

**Original image attachment**:
The immutable user-uploaded image identified by a file part's `fileId`. It
remains the canonical source even when annotations exist.
_Avoid_: Unannotated copy, source screenshot

**Image annotations**:
Structured editable marks attached to an image file part and sufficient to
reconstruct the confirmed editing result.
_Avoid_: Annotation prompt, mark text

**Annotated image**:
The rendered derivative identified by `annotatedFileId` and produced from an
original image attachment plus image annotations. It is not a second logical
attachment.
_Avoid_: Second attachment, rewritten original

**Annotation editing session**:
Composer-owned transient working state initialized from image annotations and
discarded with its owning composer.
_Avoid_: Global annotation session, saved annotation
