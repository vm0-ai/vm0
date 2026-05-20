/**
 * Shared callback payload types for all zero-layer channels.
 *
 * Each interface defines the payload shape passed from the registration handler
 * to the callback consumer route. These types provide compile-time safety while
 * the parsePayload() functions in each route provide runtime validation.
 */

/**
 * Consumed by the voice-chat task-run callback route
 * /api/internal/callbacks/voice-chat (Epic #10297, sub-issue #10311).
 * Declared here ahead of the route handler so the contract and service layers
 * that land in Wave 1–4 can import it.
 * @public
 */
export interface VoiceChatCallbackPayload {
  taskId: string;
}
