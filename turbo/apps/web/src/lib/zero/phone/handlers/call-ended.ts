import {
  resolveOrgByAgentphoneAgentId,
  resolveUserByPhone,
  lookupPhoneThreadSession,
} from "./shared";
import { runAgentForPhone } from "./run-agent";
import type { PhoneCallbackPayload } from "../../../infra/callback/callback-payloads";
import { logger } from "../../../shared/logger";

const log = logger("phone:call-ended");

interface CallEndedEvent {
  callId: string;
  agentId: string;
  fromNumber: string;
  toNumber: string;
  direction: string;
  channel: string;
  durationSeconds?: number;
  transcript?: unknown;
  summary?: string;
}

/**
 * Handle an AgentPhone call_ended webhook event.
 *
 * Flow:
 * 1. Only process inbound voice calls
 * 2. Resolve org from AgentPhone agent ID
 * 3. Resolve VM0 user from caller phone number
 * 4. Format transcript from webhook payload
 * 5. Look up existing phone thread session
 * 6. Create Zero run with transcript as prompt
 */
export async function handleCallEnded(event: CallEndedEvent): Promise<void> {
  const { callId, agentId: apAgentId, fromNumber, direction, channel } = event;

  // Only process inbound voice calls
  if (direction !== "inbound" || channel !== "voice") {
    log.debug("Skipping non-inbound-voice event", {
      callId,
      direction,
      channel,
    });
    return;
  }

  // Resolve org from AgentPhone agent ID
  const org = await resolveOrgByAgentphoneAgentId(apAgentId);
  if (!org) {
    log.warn("No org found for AgentPhone agent", { apAgentId, callId });
    return;
  }

  if (!org.defaultAgentId) {
    log.warn("Org has no default agent configured", {
      orgId: org.orgId,
      callId,
    });
    return;
  }

  // Resolve VM0 user from caller phone number
  const userId = await resolveUserByPhone(fromNumber, org.orgId);
  if (!userId) {
    log.info("Call from unverified number, ignoring", {
      fromNumber,
      orgId: org.orgId,
      callId,
    });
    return;
  }

  // Dedup check: look up existing session to check lastCallId
  const existingSession = await lookupPhoneThreadSession(userId, org.orgId);
  if (existingSession?.lastCallId === callId) {
    log.debug("Duplicate call_ended event, skipping", { callId });
    return;
  }

  // Skip run dispatch if no transcript — avoids creating valueless runs
  if (!event.transcript) {
    log.warn("No transcript in call_ended event, skipping run dispatch", {
      callId,
    });
    return;
  }

  // Use transcript from webhook payload (no API call needed)
  const transcriptText = formatTranscript(event.transcript);

  const summaryText = event.summary
    ? `\n\nReceptionist summary: ${event.summary}`
    : "";

  // Build prompt and context
  const prompt = `Phone call from ${fromNumber}:\n\n${transcriptText}${summaryText}`;
  const phoneContext = [
    `# Phone Call Context`,
    `Caller: ${fromNumber}`,
    `Call ID: ${callId}`,
    event.durationSeconds != null
      ? `Duration: ${event.durationSeconds}s`
      : null,
    ``,
    `# Available Actions`,
    `You can call the user back using: zero phone call --mode <mode> ${fromNumber}`,
    `  --mode onhold: Stay on the line until the call completes, then get the transcript back. Use when you need a quick answer from the user.`,
    `  --mode fire-and-forget: Initiate the call and return immediately. Use for open-ended conversations or when you don't need an immediate response.`,
    `You can view call history using: zero phone record`,
  ]
    .filter((line) => {
      return line !== null;
    })
    .join("\n");

  const callbackPayload: PhoneCallbackPayload = {
    callId,
    userId,
    orgId: org.orgId,
    agentId: org.defaultAgentId,
    existingSessionId: existingSession?.agentSessionId ?? null,
  };

  await runAgentForPhone({
    agentId: org.defaultAgentId,
    sessionId: existingSession?.agentSessionId,
    prompt,
    phoneContext,
    userId,
    callbackContext: callbackPayload,
  });

  log.info("Phone run dispatched", { callId, orgId: org.orgId });
}

/**
 * Format a transcript response into readable text.
 */
function formatTranscript(transcript: unknown): string {
  if (typeof transcript === "string") return transcript;

  if (Array.isArray(transcript)) {
    return transcript
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (typeof entry === "object" && entry !== null) {
          const e = entry as Record<string, unknown>;
          const role = e.role ?? e.speaker ?? "Unknown";
          const text = e.text ?? e.content ?? e.body ?? "";
          return `[${role}]: ${text}`;
        }
        return String(entry);
      })
      .join("\n");
  }

  if (typeof transcript === "object" && transcript !== null) {
    const t = transcript as Record<string, unknown>;
    if (typeof t.text === "string") return t.text;
    if (Array.isArray(t.entries)) return formatTranscript(t.entries);
    if (Array.isArray(t.messages)) return formatTranscript(t.messages);
  }

  return JSON.stringify(transcript);
}
