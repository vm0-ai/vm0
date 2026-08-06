/**
 * Canonical Pi message payload as delivered by pi.message.completed events.
 * The transcript is the model-facing source of truth; the API stores it
 * opaquely and only inspects `role` plus assistant text blocks for chat
 * projection.
 */
export type PiThreadMessagePayload = {
  readonly role: string;
} & Record<string, unknown>;
