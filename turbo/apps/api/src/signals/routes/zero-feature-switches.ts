import { command, computed } from "ccstate";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { getAllFeatureStates } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  deleteUserFeatureSwitches$,
  updateUserFeatureSwitches$,
  userFeatureSwitchOverrides,
} from "../services/feature-switches.service";
import { modelProviderGatewaySchemaAvailable } from "../services/model-provider-gateway-schema.service";

const featureSwitchesAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const LEGACY_MAIL_REPLY_FOLLOW_UP_SWITCH = "zeroMailReplyFollowUp";
function featureSwitchResponseBody(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly switches: Record<string, boolean>;
  readonly supportsStructuredInlineTemplates: boolean;
  readonly supportsCustomConnectorOAuth2: boolean;
  readonly supportsCustomModelGateways: boolean;
  readonly supportsImageRecognition: boolean;
  readonly supportsAvatarTemplates: boolean;
}) {
  const registeredEffectiveSwitches = getAllFeatureStates({
    orgId: params.orgId,
    userId: params.userId,
    overrides: params.switches,
  });
  // Platform bundles loaded before Mail follow-up removal still carry this
  // key. Force them off until their compatible follow-up endpoint can be
  // removed after the old frontend release drains.
  const effectiveSwitches = {
    ...registeredEffectiveSwitches,
    [LEGACY_MAIL_REPLY_FOLLOW_UP_SWITCH]: false,
  };

  return {
    switches: params.switches,
    effectiveSwitches,
    supportsStructuredInlineTemplates: params.supportsStructuredInlineTemplates,
    supportsCustomConnectorOAuth2: params.supportsCustomConnectorOAuth2,
    supportsCustomModelGateways: params.supportsCustomModelGateways,
    supportsImageRecognition: params.supportsImageRecognition,
    supportsAvatarTemplates: params.supportsAvatarTemplates,
  };
}

const getFeatureSwitchesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const switches = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  const supportsCustomModelGateways = await modelProviderGatewaySchemaAvailable(
    get(db$),
  );
  return {
    status: 200 as const,
    body: featureSwitchResponseBody({
      orgId: auth.orgId,
      userId: auth.userId,
      switches,
      supportsStructuredInlineTemplates: true,
      supportsCustomConnectorOAuth2: true,
      supportsCustomModelGateways,
      supportsImageRecognition: true,
      supportsAvatarTemplates: true,
    }),
  };
});

const updateFeatureSwitchesBody$ = bodyResultOf(
  zeroFeatureSwitchesContract.update,
);

const updateFeatureSwitchesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(updateFeatureSwitchesBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const switches = await set(
      updateUserFeatureSwitches$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        switches: bodyResult.data.switches,
      },
      signal,
    );
    const supportsCustomModelGateways =
      await modelProviderGatewaySchemaAvailable(get(db$));
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: featureSwitchResponseBody({
        orgId: auth.orgId,
        userId: auth.userId,
        switches,
        supportsStructuredInlineTemplates: true,
        supportsCustomConnectorOAuth2: true,
        supportsCustomModelGateways,
        supportsImageRecognition: true,
        supportsAvatarTemplates: true,
      }),
    };
  },
);

const deleteFeatureSwitchesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    await set(
      deleteUserFeatureSwitches$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    return { status: 200 as const, body: { deleted: true as const } };
  },
);

export const zeroFeatureSwitchesRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeatureSwitchesContract.get,
    handler: authRoute(featureSwitchesAuthOptions, getFeatureSwitchesInner$),
  },
  {
    route: zeroFeatureSwitchesContract.update,
    handler: authRoute(featureSwitchesAuthOptions, updateFeatureSwitchesInner$),
  },
  {
    route: zeroFeatureSwitchesContract.delete,
    handler: authRoute(featureSwitchesAuthOptions, deleteFeatureSwitchesInner$),
  },
];
