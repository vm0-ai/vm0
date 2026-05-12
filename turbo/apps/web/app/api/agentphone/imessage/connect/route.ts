import { NextResponse } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { sendAgentPhoneMessage } from "../../../../../src/lib/zero/imessage/client";
import {
  ensureIMessageOrgAndArtifact,
  linkIMessageUserToVm0User,
  normalizePhoneHandle,
} from "../../../../../src/lib/zero/imessage/shared";
import { verifyIMessageConnectSignature } from "../../../../../src/lib/zero/imessage/connect-token";
import { getAppUrl } from "../../../../../src/lib/zero/url";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("agentphone:imessage:connect");

function worksRedirect(params: Record<string, string>): NextResponse {
  const url = new URL("/works", getAppUrl());
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url.toString());
}

function signInRedirect(request: Request): NextResponse {
  const url = new URL("/sign-in", getAppUrl());
  url.searchParams.set("redirect_url", request.url);
  return NextResponse.redirect(url.toString());
}

function invalidConnectRedirect(message: string): NextResponse {
  return worksRedirect({
    imessage: "error",
    imessage_error: message,
  });
}

function conflictRedirect(reason: string): NextResponse {
  const message =
    reason === "phone-handle-linked"
      ? "This phone number is already connected to another VM0 account or organization. Disconnect it first."
      : reason === "vm0-org-linked"
        ? "Your VM0 account is already connected to another phone number for iMessage in this organization. Disconnect it first."
        : "This iMessage link already exists. Disconnect it first and try again.";

  return invalidConnectRedirect(message);
}

export async function GET(request: Request): Promise<NextResponse> {
  initServices();

  const url = new URL(request.url);
  const phoneHandle = normalizePhoneHandle(
    url.searchParams.get("handle") ?? "",
  );
  const agentphoneAgentId = url.searchParams.get("agent") ?? "";
  const timestamp = Number(url.searchParams.get("ts") ?? "");
  const signature = url.searchParams.get("sig") ?? "";

  if (!phoneHandle || !agentphoneAgentId || !signature || !timestamp) {
    return invalidConnectRedirect("Invalid iMessage connection link.");
  }

  if (
    !verifyIMessageConnectSignature({
      phoneHandle,
      agentphoneAgentId,
      timestamp,
      signature,
      secret: env().SECRETS_ENCRYPTION_KEY,
    })
  ) {
    return invalidConnectRedirect(
      "This iMessage connection link has expired. Send /connect again.",
    );
  }

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  if (!authCtx) {
    return signInRedirect(request);
  }

  const { org } = await resolveOrg(authCtx);
  const result = await linkIMessageUserToVm0User({
    phoneHandle,
    vm0UserId: authCtx.userId,
    orgId: org.orgId,
  });

  if (!result.ok) {
    return conflictRedirect(result.reason);
  }

  await ensureIMessageOrgAndArtifact(authCtx.userId, org.orgId);

  try {
    await sendAgentPhoneMessage({
      agentphoneAgentId,
      toNumber: phoneHandle,
      body: "Your phone number is connected to VM0. Send a message here to start chatting with Zero.",
    });
  } catch (error) {
    log.warn("Connected iMessage user but failed to send confirmation", {
      phoneHandle,
      vm0UserId: authCtx.userId,
      orgId: org.orgId,
      error,
    });
  }

  return worksRedirect({ imessage: "connected" });
}
