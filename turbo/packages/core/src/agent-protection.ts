import { DEFAULT_AGENT_AVATAR_URL } from "./agent-avatar";
import { DEFAULT_AGENT_DISPLAY_NAME } from "./public-brand";

interface AgentIdentityUpdate {
  readonly displayName?: string;
  readonly avatarUrl?: string | null;
  readonly visibility?: "public" | "private";
}

// New App/CLI clients can reach older API targets during rollout/rollback.
// Missing identity grants no protected action; retire old-response tolerance
// after those API targets are gone (#33251).
const identityUnavailableError = {
  code: "AGENT_IDENTITY_UNAVAILABLE",
  message: "Agent identity is unavailable. Refresh the agent and try again.",
};

/** Validate protected fields using authoritative identity, never a name. */
export function agentIdentityUpdateError(
  isDefaultAgent: boolean | undefined,
  update: AgentIdentityUpdate,
) {
  if (
    update.displayName === undefined &&
    update.avatarUrl === undefined &&
    update.visibility === undefined
  ) {
    return null;
  }
  if (typeof isDefaultAgent !== "boolean") {
    return identityUnavailableError;
  }
  if (!isDefaultAgent) {
    return null;
  }
  if (
    update.displayName !== undefined &&
    update.displayName !== DEFAULT_AGENT_DISPLAY_NAME
  ) {
    return {
      code: "DEFAULT_AGENT_NAME_LOCKED",
      message: "The workspace default agent must keep the name Okou.",
    };
  }
  if (
    update.avatarUrl !== undefined &&
    update.avatarUrl !== DEFAULT_AGENT_AVATAR_URL
  ) {
    return {
      code: "DEFAULT_AGENT_AVATAR_LOCKED",
      message: "The workspace default Okou agent must keep its default avatar.",
    };
  }
  if (update.visibility === "private") {
    return {
      code: "DEFAULT_AGENT_VISIBILITY_LOCKED",
      message: "The workspace default Okou agent must remain public.",
    };
  }
  return null;
}

export function agentDeletionError(isDefaultAgent: boolean | undefined) {
  if (typeof isDefaultAgent !== "boolean") {
    return identityUnavailableError;
  }
  return isDefaultAgent
    ? {
        code: "DEFAULT_AGENT_DELETE_LOCKED",
        message: "The workspace default Okou agent cannot be deleted.",
      }
    : null;
}
