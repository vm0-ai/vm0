import { command } from "ccstate";
import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import type { RouteEntry } from "../route";
import { audioInputQuota } from "../services/voice-io.service";

const MISSING_ORG_RESPONSE = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    }),
  }),
});

const getVoiceIoQuotaInner$ = command(async ({ get }): Promise<unknown> => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return MISSING_ORG_RESPONSE;
  }

  const body = await get(audioInputQuota(auth.orgId, auth.userId));
  return {
    status: 200 as const,
    body,
  };
});

export function zeroVoiceIoQuotaRoutes(
  source: ShadowCompareSource = "web",
): readonly RouteEntry[] {
  return [
    {
      route: zeroVoiceIoQuotaContract.get,
      handler: shadowCompareRoute({
        routeName: "zero.voice-io.quota.get",
        handler: authRoute({}, getVoiceIoQuotaInner$),
        source,
      }),
    },
  ];
}
