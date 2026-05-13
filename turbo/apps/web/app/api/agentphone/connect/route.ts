import { NextResponse } from "next/server";
import { z } from "zod";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { getAuthContext } from "../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { sendAgentPhoneMessage } from "../../../../src/lib/zero/agentphone/client";
import {
  ensureAgentPhoneOrgAndArtifact,
  linkAgentPhoneUserToVm0User,
  normalizePhoneHandle,
} from "../../../../src/lib/zero/agentphone/shared";
import { verifyAgentPhoneConnectSignature } from "../../../../src/lib/zero/agentphone/connect-token";
import { publishUserSignal } from "../../../../src/lib/infra/realtime/client";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("agentphone:connect");

const connectBodySchema = z.object({
  phoneHandle: z.string().min(1),
  agentphoneAgentId: z.string().min(1),
  timestamp: z.number(),
  signature: z.string().min(1),
});

function errorResponse(
  message: string,
  code: string,
  status: number,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

function conflictResponse(reason: string): NextResponse {
  const message =
    reason === "phone-handle-linked"
      ? "This phone number is already connected to another VM0 account or organization. Disconnect it first."
      : reason === "vm0-org-linked"
        ? "Your VM0 account is already connected to another phone number in this organization. Disconnect it first."
        : "This phone number link already exists. Disconnect it first and try again.";

  return errorResponse(message, "CONFLICT", 409);
}

export async function POST(request: Request): Promise<NextResponse> {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return errorResponse("Not authenticated", "UNAUTHORIZED", 401);
  }

  const parsed = connectBodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return errorResponse("Invalid connection link.", "BAD_REQUEST", 400);
  }

  const body = parsed.data;
  const phoneHandle = normalizePhoneHandle(body.phoneHandle);
  if (
    !phoneHandle ||
    !verifyAgentPhoneConnectSignature({
      phoneHandle,
      agentphoneAgentId: body.agentphoneAgentId,
      timestamp: body.timestamp,
      signature: body.signature,
      secret: env().SECRETS_ENCRYPTION_KEY,
    })
  ) {
    return errorResponse(
      "Invalid or expired connection link. Send /connect again.",
      "BAD_REQUEST",
      400,
    );
  }

  const { org } = await resolveOrg(authCtx);
  const result = await linkAgentPhoneUserToVm0User({
    phoneHandle,
    vm0UserId: authCtx.userId,
    orgId: org.orgId,
  });

  if (!result.ok) {
    return conflictResponse(result.reason);
  }

  await ensureAgentPhoneOrgAndArtifact(authCtx.userId, org.orgId);

  try {
    await publishUserSignal([authCtx.userId], "agentphone:changed");
  } catch (error) {
    log.warn(
      "Connected AgentPhone user but failed to publish realtime signal",
      {
        phoneHandle,
        vm0UserId: authCtx.userId,
        orgId: org.orgId,
        error,
      },
    );
  }

  try {
    await sendAgentPhoneMessage({
      agentphoneAgentId: body.agentphoneAgentId,
      toNumber: phoneHandle,
      body: "Your phone number is connected to VM0. Send a message here to start chatting with Zero.",
    });
  } catch (error) {
    log.warn("Connected AgentPhone user but failed to send confirmation", {
      phoneHandle,
      vm0UserId: authCtx.userId,
      orgId: org.orgId,
      error,
    });
  }

  return NextResponse.json({ phoneHandle });
}
