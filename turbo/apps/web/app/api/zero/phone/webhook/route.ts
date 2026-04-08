import { after } from "next/server";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { initServices } from "../../../../../src/lib/init-services";
import { handleCallEnded } from "../../../../../src/lib/zero/phone/handlers/call-ended";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:phone:webhook");

const webhookBodySchema = z.record(z.string(), z.unknown());

/**
 * AgentPhone webhook receiver.
 *
 * Payload structure (from AgentPhone docs):
 * {
 *   "event": "agent.call_ended",
 *   "channel": "voice",
 *   "agentId": "agent_123",
 *   "timestamp": "...",
 *   "data": {
 *     "conversationId": "conv_abc",
 *     "from": "+14155551234",
 *     "to": "+18571234567",
 *     "direction": "inbound",
 *     ...
 *   },
 *   "recentHistory": [...]
 * }
 */
export async function POST(request: Request): Promise<Response> {
  initServices();

  const parsed = webhookBodySchema.safeParse(
    await request.json().catch(() => {
      return null;
    }),
  );
  if (!parsed.success) {
    return new Response("Bad Request", { status: 400 });
  }
  const body = parsed.data;

  // Dump webhook payload for local testing/debugging
  try {
    const dumpDir = path.join(process.cwd(), ".webhook-dumps");
    fs.mkdirSync(dumpDir, { recursive: true });
    const filename = `phone-${Date.now()}.json`;
    fs.writeFileSync(
      path.join(dumpDir, filename),
      JSON.stringify(body, null, 2),
    );
  } catch {
    // Non-critical — ignore dump failures
  }

  const eventType = typeof body.event === "string" ? body.event : undefined;
  const channel = typeof body.channel === "string" ? body.channel : "voice";
  const agentId = typeof body.agentId === "string" ? body.agentId : undefined;

  if (eventType !== "call_ended" && eventType !== "agent.call_ended") {
    log.debug("Ignoring non-call_ended event", { eventType });
    return new Response("OK", { status: 200 });
  }

  // Extract fields from data object
  const data = (
    typeof body.data === "object" && body.data !== null ? body.data : {}
  ) as Record<string, unknown>;

  const dataCallId =
    typeof data.callId === "string"
      ? data.callId
      : typeof data.conversationId === "string"
        ? data.conversationId
        : undefined;
  const fromNumber = typeof data.from === "string" ? data.from : undefined;
  const toNumber = typeof data.to === "string" ? data.to : undefined;
  const direction =
    typeof data.direction === "string" ? data.direction : "inbound";
  const durationSeconds =
    typeof data.durationSeconds === "number"
      ? data.durationSeconds
      : typeof data.duration === "number"
        ? data.duration
        : undefined;

  const callId = dataCallId;

  if (!callId || !agentId || !fromNumber) {
    log.warn("Missing required fields in call_ended event", {
      callId,
      agentId,
      fromNumber,
      bodyKeys: Object.keys(body),
      dataKeys: Object.keys(data),
    });
    return new Response("OK", { status: 200 });
  }

  log.info("Processing call_ended webhook", {
    callId,
    agentId,
    fromNumber,
    direction,
    channel,
  });

  // Extract transcript and summary directly from webhook payload
  const transcript = data.transcript;
  const summary = typeof data.summary === "string" ? data.summary : undefined;

  after(
    handleCallEnded({
      callId,
      agentId,
      fromNumber,
      toNumber: toNumber ?? "",
      direction,
      channel,
      durationSeconds,
      transcript,
      summary,
    }).catch((error) => {
      log.error("Failed to handle call_ended", { callId, error });
    }),
  );

  return new Response("OK", { status: 200 });
}
