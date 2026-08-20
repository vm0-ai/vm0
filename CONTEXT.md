# Domain glossary

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

The billing context decides whether a purchase can be reviewed and confirmed inside vm0 or must continue on a Stripe-hosted page.

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
