/**
 * Event sending module for VM0 agent scripts.
 * Sends JSONL events to the webhook endpoint.
 * Masks secrets before sending using client-side masking.
 */
import * as fs from "fs";
import {
  RUN_ID,
  WORKING_DIR,
  WEBHOOK_URL,
  CLI_AGENT_TYPE,
  SESSION_ID_FILE,
  SESSION_HISTORY_PATH_FILE,
  EVENT_ERROR_FLAG,
} from "./common.js";
import { logInfo, logError } from "./log.js";
import { httpPostJson } from "./http-client.js";
import { maskData } from "./secret-masker.js";

interface AgentEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  thread_id?: string;
  sequenceNumber?: number;
  [key: string]: unknown;
}

/**
 * Send single event immediately to webhook.
 * Masks secrets before sending.
 *
 * @param event - Event dictionary to send
 * @param sequenceNumber - Sequence number for this event (1-based, maintained by caller)
 * @returns true on success, false on failure
 */
export async function sendEvent(
  event: AgentEvent,
  sequenceNumber: number,
): Promise<boolean> {
  // Extract session ID from init event based on CLI agent type
  const eventType = event.type ?? "";
  const eventSubtype = event.subtype ?? "";

  // Claude Code: session_id from system/init event
  // Codex: thread_id from thread.started event
  let sessionId: string | null = null;
  if (CLI_AGENT_TYPE === "codex") {
    if (eventType === "thread.started") {
      sessionId = (event.thread_id as string) ?? "";
    }
  } else {
    if (eventType === "system" && eventSubtype === "init") {
      sessionId = (event.session_id as string) ?? "";
    }
  }

  if (sessionId && !fs.existsSync(SESSION_ID_FILE)) {
    logInfo(`Captured session ID: ${sessionId}`);

    // Save to temp file to persist across subprocesses
    fs.writeFileSync(SESSION_ID_FILE, sessionId);

    // Calculate session history path based on CLI agent type
    const homeDir = process.env.HOME ?? "/home/user";

    let sessionHistoryPath: string;
    if (CLI_AGENT_TYPE === "codex") {
      // Codex stores sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
      // We'll store a marker path here; checkpoint.py will search for the actual file
      const codexHome = process.env.CODEX_HOME ?? `${homeDir}/.codex`;
      // Use special marker format that checkpoint.ts will recognize
      sessionHistoryPath = `CODEX_SEARCH:${codexHome}/sessions:${sessionId}`;
    } else {
      // Claude Code uses ~/.claude (default, no CLAUDE_CONFIG_DIR override)
      // Path encoding: e.g., /home/user/workspace -> -home-user-workspace
      const projectName = WORKING_DIR.replace(/^\//, "").replace(/\//g, "-");
      sessionHistoryPath = `${homeDir}/.claude/projects/-${projectName}/${sessionId}.jsonl`;
    }

    fs.writeFileSync(SESSION_HISTORY_PATH_FILE, sessionHistoryPath);

    logInfo(`Session history will be at: ${sessionHistoryPath}`);
  }

  // Add sequence number to event
  const eventWithSequence: AgentEvent = {
    ...event,
    sequenceNumber,
  };

  // Mask secrets in event data before sending
  // This ensures secrets are never sent to the server in plaintext
  const maskedEvent = maskData(eventWithSequence as Record<string, unknown>);

  // Build payload with masked event
  const payload = {
    runId: RUN_ID,
    events: [maskedEvent],
  };

  // Send event using HTTP request function
  const result = await httpPostJson(WEBHOOK_URL, payload);

  if (result === null) {
    logError("Failed to send event after retries");
    // Mark that event sending failed - run-agent will check this
    fs.writeFileSync(EVENT_ERROR_FLAG, "1");
    return false;
  }

  return true;
}
