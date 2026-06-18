import { command, computed } from "ccstate";
import { zeroAgentDraftContract } from "@vm0/api-contracts/contracts/zero-agents";
import { zeroAgentDrafts } from "@vm0/db/schema/zero-agent-draft";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { notFound } from "../../lib/error";
import { zeroAgentExists } from "../services/zero-agent-data.service";
import type { RouteEntry } from "../route";

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

const getAgentDraftInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentDraftContract.get));

  const agentExists = await get(
    zeroAgentExists({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!agentExists) {
    return agentNotFound(params.id);
  }

  const [draft] = await get(db$)
    .select({
      draftContent: zeroAgentDrafts.draftContent,
      draftAttachments: zeroAgentDrafts.draftAttachments,
    })
    .from(zeroAgentDrafts)
    .where(
      and(
        eq(zeroAgentDrafts.userId, auth.userId),
        eq(zeroAgentDrafts.orgId, auth.orgId),
        eq(zeroAgentDrafts.agentId, params.id),
      ),
    )
    .limit(1);

  return {
    status: 200 as const,
    body: {
      draftContent: draft?.draftContent ?? null,
      draftAttachments: draft?.draftAttachments ?? null,
    },
  };
});

const patchAgentDraftInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroAgentDraftContract.patch));

    const bodyResult = await get(bodyResultOf(zeroAgentDraftContract.patch));
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const agentExists = await get(
      zeroAgentExists({
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: params.id,
      }),
    );
    signal.throwIfAborted();
    if (!agentExists) {
      return agentNotFound(params.id);
    }

    const draftContent = bodyResult.data.draftContent ?? null;
    const draftAttachments = bodyResult.data.draftAttachments ?? null;
    const writeDb = set(writeDb$);

    if (!draftContent && !(draftAttachments && draftAttachments.length > 0)) {
      await writeDb
        .delete(zeroAgentDrafts)
        .where(
          and(
            eq(zeroAgentDrafts.userId, auth.userId),
            eq(zeroAgentDrafts.orgId, auth.orgId),
            eq(zeroAgentDrafts.agentId, params.id),
          ),
        );
      signal.throwIfAborted();
      return { status: 204 as const, body: undefined };
    }

    const updatedAt = nowDate();
    await writeDb
      .insert(zeroAgentDrafts)
      .values({
        userId: auth.userId,
        orgId: auth.orgId,
        agentId: params.id,
        draftContent,
        draftAttachments,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          zeroAgentDrafts.userId,
          zeroAgentDrafts.orgId,
          zeroAgentDrafts.agentId,
        ],
        set: {
          draftContent,
          draftAttachments,
          updatedAt,
        },
      });
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const zeroAgentDraftRoutes: readonly RouteEntry[] = [
  {
    route: zeroAgentDraftContract.get,
    handler: authRoute(agentReadAuth, getAgentDraftInner$),
  },
  {
    route: zeroAgentDraftContract.patch,
    handler: authRoute(agentReadAuth, patchAgentDraftInner$),
  },
];
