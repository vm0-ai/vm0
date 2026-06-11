/**
 * High-level Ably-event helpers for use in tests.
 *
 * Each function fires the real-time event that the production app subscribes
 * to for a given chat-thread lifecycle transition. Use these instead of
 * calling triggerAblyEvent() directly with raw topic strings.
 */
import { triggerAblyEvent } from "./ably.ts";

/** Simulate a new chat message being created in a thread. */
export function createChatMessage(threadId: string): void {
  triggerAblyEvent(`chatThreadMessageCreated:${threadId}`);
}

/** Simulate a new run being created in a thread. */
export function createChatRun(threadId: string): void {
  triggerAblyEvent(`chatThreadRunCreated:${threadId}`);
}

/** Simulate a run status update in a thread (e.g. completed, failed, cancelled). */
export function updateChatRun(threadId: string): void {
  triggerAblyEvent(`chatThreadRunUpdated:${threadId}`);
}
