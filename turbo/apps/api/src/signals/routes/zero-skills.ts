import { command, computed } from "ccstate";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
} from "@vm0/api-contracts/contracts/zero-agents";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import { zeroSkillList } from "../services/zero-catalog-data.service";
import { updateZeroSkill$ } from "../services/zero-skill-update.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can update custom skills",
      code: "FORBIDDEN",
    }),
  }),
});

const listSkillsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const skills = await get(zeroSkillList(auth.orgId));
  return { status: 200 as const, body: [...skills] };
});

const updateSkillInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const params = get(pathParamsOf(zeroSkillsDetailContract.update));
  const bodyResult = await get(bodyResultOf(zeroSkillsDetailContract.update));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const updated = await set(
    updateZeroSkill$,
    {
      orgId: auth.orgId,
      skillName: params.name,
      files: bodyResult.data.files,
    },
    signal,
  );
  signal.throwIfAborted();

  if (!updated) {
    return notFound(`Skill not found: ${params.name}`);
  }

  return { status: 200 as const, body: updated };
});

export const zeroSkillsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSkillsCollectionContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:read",
      },
      listSkillsInner$,
    ),
  },
  {
    route: zeroSkillsDetailContract.update,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:write",
      },
      updateSkillInner$,
    ),
  },
];
