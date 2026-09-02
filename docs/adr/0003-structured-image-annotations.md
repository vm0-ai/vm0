# Persist image annotations on one logical file part

Status: Accepted — 2026-09-02

## Context

Image annotation previously lived on draft attachment transport metadata. At send time, the client rendered a second file, expanded one attachment into two file parts, and converted the editable marks into prompt text. That made the user-message document unable to reconstruct the editor by itself, allowed draft synchronization paths to drop marks, and coupled agent serialization to composer state.

## Decision

An annotated image remains one logical `file` part. Its `fileId` always identifies the immutable original; `annotatedFileId` identifies the confirmed rendered derivative; and `annotations` contains the structured marks needed to reconstruct the editor.

The composer owns the only active annotation editing session. Confirming an edit stores `annotations` immediately, closes the editor, renders and uploads the derivative, and blocks sending until `annotatedFileId` is available. Draft attachment metadata remains transport-only, so unfinished annotations are persisted in the draft user-message document without changing database or local snapshot versions.

For an annotated file, the agent receives the rendered derivative as its web file followed by the complete structured file part. The original is still authorized and registered as an input asset, but it is not emitted as a second agent-visible web-file block.

## Consequences

Draft restore, copy/paste, recall, and transfer can reproduce the editable result from the user-message document. Rendering or upload failure leaves the annotations available for retry and prevents an incomplete annotated message from being sent. Re-editing creates a new derivative without synchronously deleting the previous immutable file, so orphan cleanup remains an independent storage concern.
