import { command, computed } from "ccstate";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { SEED_SKILLS } from "@vm0/core/zero-seed-skills";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { conflict, notFound } from "../../lib/error";
import { writeDb$ } from "../external/db";
import { zeroSkillList } from "../services/zero-catalog-data.service";
import { uploadVolumeServerSide$ } from "../services/storage-volume-upload.service";
import { deleteZeroSkill$ } from "../services/zero-skill-delete.service";
import { updateZeroSkill$ } from "../services/zero-skill-update.service";
import type { RouteEntry } from "../route";

const createAdminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can create custom skills",
      code: "FORBIDDEN",
    }),
  }),
});

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can update custom skills",
      code: "FORBIDDEN",
    }),
  }),
});

const deleteAdminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can delete custom skills",
      code: "FORBIDDEN",
    }),
  }),
});

const createSkillBody$ = bodyResultOf(zeroSkillsCollectionContract.create);
const updateSkillBody$ = bodyResultOf(zeroSkillsDetailContract.update);

const listSkillsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const skills = await get(zeroSkillList(auth.orgId));
  return { status: 200 as const, body: [...skills] };
});

const createSkillInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return createAdminRequired;
  }

  const bodyResult = await get(createSkillBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  if (SEED_SKILLS.includes(body.name)) {
    return conflict(
      `Skill name "${body.name}" conflicts with a built-in skill`,
    );
  }

  const writeDb = set(writeDb$);
  const [existingSkill] = await writeDb
    .select({ id: zeroSkills.id })
    .from(zeroSkills)
    .where(
      and(eq(zeroSkills.orgId, auth.orgId), eq(zeroSkills.name, body.name)),
    )
    .limit(1);
  signal.throwIfAborted();

  if (existingSkill) {
    return conflict(`Skill "${body.name}" already exists in this organization`);
  }

  await writeDb.insert(zeroSkills).values({
    orgId: auth.orgId,
    name: body.name,
    displayName: body.displayName ?? null,
    description: body.description ?? null,
    createdBy: auth.userId,
  });
  signal.throwIfAborted();

  await set(
    uploadVolumeServerSide$,
    {
      orgId: auth.orgId,
      storageName: getCustomSkillStorageName(body.name),
      files: body.files,
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 201 as const,
    body: {
      name: body.name,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
    },
  };
});

const updateSkillInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const params = get(pathParamsOf(zeroSkillsDetailContract.update));
  const bodyResult = await get(updateSkillBody$);
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

const deleteSkillInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return deleteAdminRequired;
  }

  const params = get(pathParamsOf(zeroSkillsDetailContract.delete));
  const deleted = await set(
    deleteZeroSkill$,
    { orgId: auth.orgId, skillName: params.name },
    signal,
  );
  signal.throwIfAborted();

  if (!deleted) {
    return notFound(`Skill not found: ${params.name}`);
  }

  return { status: 204 as const, body: undefined };
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
    route: zeroSkillsCollectionContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:write",
      },
      createSkillInner$,
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
  {
    route: zeroSkillsDetailContract.delete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent:write",
      },
      deleteSkillInner$,
    ),
  },
];
