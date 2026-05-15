import { NextResponse } from "next/server";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { z } from "zod";
import type { AuthContext } from "../../../../src/lib/auth/get-auth-context";
import { loadFeatureSwitchOverrides } from "../../../../src/lib/zero/user/feature-switches-service";

export const voiceChatTokenBodySchema = z.object({
  sessionId: z.uuid(),
  noiseReduction: z.enum(["near_field", "far_field"]).optional(),
});

interface VoiceChatGates {
  /** FeatureSwitchKey.Trinity — top-level voice-chat gate (#10618). */
  voiceChatEnabled: boolean;
  /**
   * FeatureSwitchKey.VoiceChatRealtimeBilling — when ON, the token route
   * runs credit + pricing admission and the /session-started, /usage,
   * /session-ended endpoints record + accept browser-reported usage
   * (Plan D, Epic #12128). When OFF, those endpoints are 200 no-ops.
   * Default OFF; staff-org rollout.
   */
  realtimeBillingEnabled: boolean;
}

/**
 * Resolve both voice-chat feature gates with a single overrides load.
 */
export async function loadVoiceChatGates(
  authCtx: AuthContext,
): Promise<VoiceChatGates> {
  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const evalKey = (key: FeatureSwitchKey) => {
    return isFeatureEnabled(key, {
      orgId: authCtx.orgId,
      userId: authCtx.userId,
      overrides,
    });
  };
  return {
    voiceChatEnabled: evalKey(FeatureSwitchKey.Trinity),
    realtimeBillingEnabled: evalKey(FeatureSwitchKey.VoiceChatRealtimeBilling),
  };
}

export function unauthorizedResponse(): Response {
  return NextResponse.json(
    { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
    { status: 401 },
  );
}

export function forbiddenResponse(): Response {
  return NextResponse.json(
    { error: { message: "Voice chat is not enabled", code: "FORBIDDEN" } },
    { status: 403 },
  );
}

export function notFoundResponse(message: string): Response {
  return NextResponse.json(
    { error: { message, code: "NOT_FOUND" } },
    { status: 404 },
  );
}

export function badRequestResponse(
  message: string,
  code: string = "BAD_REQUEST",
): Response {
  return NextResponse.json({ error: { message, code } }, { status: 400 });
}
