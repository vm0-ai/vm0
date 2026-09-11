import { command, computed } from "ccstate";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";

import { badRequestMessage } from "../../lib/error";
import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  ensureMorningBriefDefaultEnabled$,
  type EnsureMorningBriefDefaultEnabledResult,
} from "../services/morning-brief-preference.service";
import {
  updateUserPreferences$,
  userPreferences,
} from "../services/user-data.service";
import { tapError } from "../utils";

const L = logger("user-preferences");

const updateUserPreferencesBody$ = bodyResultOf(userPreferencesContract.update);

async function observeMorningBriefProvisioning(
  task: Promise<EnsureMorningBriefDefaultEnabledResult>,
  context: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  const provisioning = await task;
  const details = { ...context, provisioning };
  if (provisioning.outcome === "failed") {
    L.warn("Morning Brief timezone provisioning outcome", details);
    return;
  }
  L.debug("Morning Brief timezone provisioning outcome", details);
}

function enqueueMorningBriefProvisioning(
  task: Promise<EnsureMorningBriefDefaultEnabledResult>,
  context: { readonly orgId: string; readonly userId: string },
): void {
  waitUntil(
    tapError(observeMorningBriefProvisioning(task, context), (error) => {
      L.error("Morning Brief timezone provisioning failed", {
        ...context,
        error,
      });
    }),
  );
}

const getUserPreferencesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const preferences = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body: preferences,
  };
});

const updateUserPreferencesInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(updateUserPreferencesBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      updateUserPreferences$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        preferences: body.data,
      },
      signal,
    );
    if (!result.ok) {
      return badRequestMessage(result.message);
    }
    if (body.data.timezone !== undefined) {
      enqueueMorningBriefProvisioning(
        set(
          ensureMorningBriefDefaultEnabled$,
          {
            orgId: auth.orgId,
            member: {
              userId: auth.userId,
              role: auth.orgRole ?? "member",
            },
          },
          signal,
        ),
        { orgId: auth.orgId, userId: auth.userId },
      );
    }
    return {
      status: 200 as const,
      body: result.data,
    };
  },
);

export const userPreferencesRoutes: readonly RouteEntry[] = [
  {
    route: userPreferencesContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserPreferencesInner$,
    ),
  },
  {
    route: userPreferencesContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserPreferencesInner$,
    ),
  },
];
