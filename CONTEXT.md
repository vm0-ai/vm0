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
