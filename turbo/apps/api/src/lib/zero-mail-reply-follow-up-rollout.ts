import { optionalEnv } from "./env";

/**
 * Keep the writer disabled until old API readers have drained. Remove this
 * gate only after every rollback-eligible API version accepts Gmail
 * new-message event configurations with threadId.
 */
export function isZeroMailReplyFollowUpRolloutEnabled(): boolean {
  return optionalEnv("ZERO_MAIL_REPLY_FOLLOW_UP_ROLLOUT_ENABLED") === "true";
}
