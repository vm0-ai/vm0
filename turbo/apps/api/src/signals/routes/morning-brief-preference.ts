import { morningBriefPreferenceContract } from "@okouai/api-contracts/contracts/morning-brief-preference";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { publicBrand$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  morningBriefPreference$,
  updateMorningBriefPreference$,
  type MorningBriefPreferenceFailure,
} from "../services/morning-brief-preference.service";

const morningBriefPreferenceReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

const morningBriefEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.MorningBrief, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const morningBriefPreferenceWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

function memberFromAuth(auth: {
  readonly userId: string;
  readonly orgRole?: string | null;
}) {
  return { userId: auth.userId, role: auth.orgRole ?? "member" };
}

function failureResponse(failure: MorningBriefPreferenceFailure) {
  return {
    status: failure.kind === "bad-request" ? (400 as const) : (409 as const),
    body: { error: { code: failure.code, message: failure.message } },
  };
}

const getMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await get(morningBriefEnabled$))) {
      return forbidden("Morning Brief is not enabled");
    }
    signal.throwIfAborted();
    const result = await set(
      morningBriefPreference$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok"
      ? { status: 200 as const, body: result.preference }
      : failureResponse(result);
  },
);

const updateBody$ = bodyResultOf(morningBriefPreferenceContract.update);
const updateMorningBriefPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await get(morningBriefEnabled$))) {
      return forbidden("Morning Brief is not enabled");
    }
    signal.throwIfAborted();
    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result = await set(
      updateMorningBriefPreference$,
      {
        orgId: auth.orgId,
        member: memberFromAuth(auth),
        enabled: body.data.enabled,
        publicBrand:
          auth.tokenType === "agent" ? auth.publicBrand : get(publicBrand$),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok"
      ? { status: 200 as const, body: result.preference }
      : failureResponse(result);
  },
);

export const morningBriefPreferenceRoutes: readonly RouteEntry[] = [
  {
    route: morningBriefPreferenceContract.get,
    handler: authRoute(
      morningBriefPreferenceReadAuth,
      getMorningBriefPreferenceInner$,
    ),
  },
  {
    route: morningBriefPreferenceContract.update,
    handler: authRoute(
      morningBriefPreferenceWriteAuth,
      updateMorningBriefPreferenceInner$,
    ),
  },
];
