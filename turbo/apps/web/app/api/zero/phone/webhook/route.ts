import { after } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../../src/lib/init-services";
import { handleCallEnded } from "../../../../../src/lib/zero/phone/handlers/call-ended";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:phone:webhook");

function extractString(
  obj: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    if (typeof obj[key] === "string") return obj[key];
  }
  return undefined;
}

function extractNumber(
  obj: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    if (typeof obj[key] === "number") return obj[key];
  }
  return undefined;
}

const webhookBodySchema = z.record(z.string(), z.unknown());

/**
 * AgentPhone webhook receiver.
 * Receives call_ended events and dispatches Zero runs.
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

  const eventType = extractString(body, "eventType", "event");
  if (eventType !== "call_ended") {
    log.debug("Ignoring non-call_ended event", { eventType });
    return new Response("OK", { status: 200 });
  }

  const callId = extractString(body, "callId", "call_id");
  const callData = (
    typeof body.data === "object" && body.data !== null ? body.data : body
  ) as Record<string, unknown>;

  const agentId = extractString(callData, "agentId", "agent_id");
  const fromNumber = extractString(callData, "fromNumber", "from_number");
  const toNumber = extractString(callData, "toNumber", "to_number");
  const direction = extractString(callData, "direction");
  const channel = extractString(callData, "channel") ?? "voice";
  const durationSeconds = extractNumber(
    callData,
    "durationSeconds",
    "duration_seconds",
  );

  if (!callId || !agentId || !fromNumber) {
    log.warn("Missing required fields in call_ended event", {
      callId,
      agentId,
      fromNumber,
    });
    return new Response("OK", { status: 200 });
  }

  after(
    handleCallEnded({
      callId,
      agentId,
      fromNumber,
      toNumber: toNumber ?? "",
      direction: direction ?? "inbound",
      channel,
      durationSeconds,
    }).catch((error) => {
      log.error("Failed to handle call_ended", { callId, error });
    }),
  );

  return new Response("OK", { status: 200 });
}
