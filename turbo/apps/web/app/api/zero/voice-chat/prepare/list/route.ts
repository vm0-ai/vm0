import { NextResponse } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";
import { listFreshPreparations } from "../../../../../../src/lib/zero/voice-chat/preparation-service";
import { loadFeatureSwitchOverrides } from "../../../../../../src/lib/zero/user/feature-switches-service";

export async function GET(request: Request) {
  initServices();

  const authCtx = await getAuthContext(
    request.headers.get("authorization") ?? undefined,
  );
  const org = await resolveOrg(authCtx);

  const overrides = await loadFeatureSwitchOverrides(authCtx.userId);
  if (!isFeatureEnabled(FeatureSwitchKey.VOICE_CHAT, overrides)) {
    return NextResponse.json(
      { error: { message: "Voice chat is not enabled" } },
      { status: 403 },
    );
  }

  const preparations = await listFreshPreparations(org.id, authCtx.userId);

  return NextResponse.json({
    preparations: preparations.map((p) => {
      return {
        id: p.id,
        mode: p.mode,
        prompt: p.prompt,
        agentId: p.agentId,
        createdAt: p.createdAt.toISOString(),
      };
    }),
  });
}
