import {
  resolveOrgByAgentphoneAgentId,
  resolveUserByPhone,
  lookupPhoneThreadSession,
  consumePendingOutboundCall,
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
 * Flow for inbound calls:
 * 1. Resolve org from AgentPhone agent ID
 * 2. Resolve VM0 user from caller phone number
 * 3. Format transcript and create Zero run
 *
 * Flow for outbound fire-and-forget calls:
 * 1. Check pending_outbound_calls for a registered record
 * 2. If found, create a follow-up run with the transcript
 *    so the agent can process the user's response
 */
export async function handleCallEnded(
  event: CallEndedEvent,
  apiStartTime: number,
): Promise<void> {
  const { callId, agentId: apAgentId, fromNumber, direction, channel } = event;

  if (channel !== "voice") {
    log.debug("Skipping non-voice event", { callId, channel });
    return;
  }

  if (direction === "outbound") {
    await handleOutboundCallEnded(event, apiStartTime);
    return;
  }

  if (direction !== "inbound") {
    log.debug("Skipping unknown direction", { callId, direction });
    return;
  }

  // --- Inbound call handling (unchanged) ---

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
  const phoneContext = buildPhoneContext({
    callerNumber: fromNumber,
    callId,
    durationSeconds: event.durationSeconds,
  });

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
    apiStartTime,
  });

  log.info("Phone run dispatched", { callId, orgId: org.orgId });
}

/**
 * Handle an outbound call_ended event for fire-and-forget calls.
 * Consumes the pending record and creates a follow-up run with the transcript.
 */
async function handleOutboundCallEnded(
  event: CallEndedEvent,
  apiStartTime: number,
): Promise<void> {
  const { callId } = event;

  // Check if this outbound call was registered as fire-and-forget.
  // consumePendingOutboundCall atomically reads and deletes the record.
  const pending = await consumePendingOutboundCall(callId);
  if (!pending) {
    log.debug("Outbound call not pending follow-up, skipping", { callId });
    return;
  }

  if (!event.transcript) {
    log.warn("No transcript in outbound call_ended event, skipping follow-up", {
      callId,
    });
    return;
  }

  const transcriptText = formatTranscript(event.transcript);
  const summaryLine = event.summary ? `\nSummary: ${event.summary}` : null;

  const prompt = [
    `You previously made an outbound call to ${event.toNumber}.`,
    `Here is the full conversation from that call:`,
    ``,
    transcriptText,
    summaryLine,
    ``,
    `Based on the above conversation, decide what to do next.`,
  ]
    .filter((line) => {
      return line !== null;
    })
    .join("\n");
  const phoneContext = buildPhoneContext({
    callerNumber: event.toNumber,
    callId,
    durationSeconds: event.durationSeconds,
  });

  const callbackPayload: PhoneCallbackPayload = {
    callId,
    userId: pending.userId,
    orgId: pending.orgId,
    agentId: pending.agentId,
    existingSessionId: pending.sessionId,
  };

  await runAgentForPhone({
    agentId: pending.agentId,
    sessionId: pending.sessionId ?? undefined,
    prompt,
    phoneContext,
    userId: pending.userId,
    callbackContext: callbackPayload,
    apiStartTime,
  });

  log.info("Follow-up run dispatched for outbound call", {
    callId,
    orgId: pending.orgId,
  });
}

function buildPhoneContext(opts: {
  callerNumber: string;
  callId: string;
  durationSeconds?: number;
}): string {
  return [
    `# Phone Call Context`,
    `Caller: ${opts.callerNumber}`,
    `Call ID: ${opts.callId}`,
    opts.durationSeconds != null ? `Duration: ${opts.durationSeconds}s` : null,
    ``,
    `# Available Actions`,
    `You can call the user back using: zero phone call --mode <mode> ${opts.callerNumber}`,
    `  --mode onhold: Stay on the line until the call completes, then get the transcript back. Use when you need a quick answer from the user.`,
    `  --mode fire-and-forget: Initiate the call and return immediately. Use for open-ended conversations or when you don't need an immediate response.`,
    `You can view call history using: zero phone record`,
  ]
    .filter((line) => {
      return line !== null;
    })
    .join("\n");
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
