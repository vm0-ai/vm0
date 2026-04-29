import { computed } from "ccstate";
import { zeroVoiceIoQuotaContract } from "@vm0/api-contracts/contracts/zero-voice-io-quota";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import type { RouteEntry } from "../route";
import { audioInputQuota } from "../services/voice-io.service";

const getVoiceIoQuotaInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
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
        handler: authRoute(
          { requireOrganization: true, missingOrganizationStatus: 401 },
          getVoiceIoQuotaInner$,
        ),
        source,
      }),
    },
  ];
}
