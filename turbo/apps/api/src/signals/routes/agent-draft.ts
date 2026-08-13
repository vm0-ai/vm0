import { command, computed } from "ccstate";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { agentDrafts } from "@okouai/db/schema/agent-draft";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { notFound } from "../../lib/error";
import { zeroAgentExists } from "../services/zero-agent-data.service";
import type { RouteEntry } from "../route-entry";

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
  const params = get(pathParamsOf(agentDraftContract.get));

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
      draftUserMessage: agentDrafts.draftUserMessage,
      draftAttachments: agentDrafts.draftAttachments,
    })
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.userId, auth.userId),
        eq(agentDrafts.orgId, auth.orgId),
        eq(agentDrafts.agentId, params.id),
      ),
    )
    .limit(1);

  return {
    status: 200 as const,
    body: {
      draftUserMessage: draft?.draftUserMessage ?? null,
      draftAttachments: draft?.draftAttachments ?? null,
    },
  };
});

const patchAgentDraftInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(agentDraftContract.patch));

    const bodyResult = await get(bodyResultOf(agentDraftContract.patch));
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

    const draftAttachments = bodyResult.data.draftAttachments ?? null;
    const draftUserMessage = bodyResult.data.draftUserMessage;
    const writeDb = set(writeDb$);

    if (
      !draftUserMessage &&
      !(draftAttachments && draftAttachments.length > 0)
    ) {
      await writeDb
        .delete(agentDrafts)
        .where(
          and(
            eq(agentDrafts.userId, auth.userId),
            eq(agentDrafts.orgId, auth.orgId),
            eq(agentDrafts.agentId, params.id),
          ),
        );
      signal.throwIfAborted();
      return { status: 204 as const, body: undefined };
    }

    const updatedAt = nowDate();
    await writeDb
      .insert(agentDrafts)
      .values({
        userId: auth.userId,
        orgId: auth.orgId,
        agentId: params.id,
        draftUserMessage,
        draftAttachments,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [agentDrafts.userId, agentDrafts.orgId, agentDrafts.agentId],
        set: {
          draftUserMessage,
          draftAttachments,
          updatedAt,
        },
      });
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const agentDraftRoutes: readonly RouteEntry[] = [
  {
    route: agentDraftContract.get,
    handler: authRoute(agentReadAuth, getAgentDraftInner$),
  },
  {
    route: agentDraftContract.patch,
    handler: authRoute(agentReadAuth, patchAgentDraftInner$),
  },
];
