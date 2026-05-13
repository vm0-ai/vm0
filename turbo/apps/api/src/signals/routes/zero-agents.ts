import { command, computed, type Computed } from "ccstate";
import { and, count, eq, inArray } from "drizzle-orm";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
  type ZeroAgentVisibility,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { connectorTypeSchema } from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroSkills } from "@vm0/db/schema/zero-skill";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { conflict, notFound } from "../../lib/error";
import {
  requireAdminPermission,
  requireAgentPermission,
} from "../../lib/require-agent-permission";
import {
  recomposeAgentIfStale$,
  serverSideZeroAgentCompose$,
} from "../services/agent-compose.service";
import { deleteComposeById$ } from "../services/zero-compose-data.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  agentResponse,
  defaultAgentResponse,
  zeroAgentDetail,
  zeroAgentEnabledConnectorTypes,
  zeroAgentEnabledCustomConnectorIds,
  zeroAgentExists,
  zeroAgentList,
  visibleJoinedZeroAgentCondition,
} from "../services/zero-agent-data.service";
import type { RouteEntry } from "../route";

const PUBLIC_AGENT_LIMIT = 7;

interface AgentUpdateBody {
  readonly displayName?: string;
  readonly description?: string;
  readonly sound?: string;
  readonly avatarUrl?: string | null;
  readonly customSkills?: readonly string[];
  readonly visibility?: ZeroAgentVisibility;
}

interface ExistingAgentVisibility {
  readonly owner: string | null;
  readonly visibility: ZeroAgentVisibility | null;
}

interface ExistingAgentForUpdate extends ExistingAgentVisibility {
  readonly id: string;
  readonly name: string;
  readonly customSkills: readonly string[] | null;
}

interface AgentMember {
  readonly userId: string;
  readonly role: string;
}

type SignalGetter = {
  <T>(source: Computed<T>): T;
  <T>(source: Computed<Promise<T>>): Promise<T>;
};

function agentNotFound(agentId: string) {
  return notFound(`Agent not found: ${agentId}`);
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function validationError(message: string) {
  return {
    status: 400 as const,
    body: { error: { message, code: "VALIDATION_ERROR" as const } },
  };
}

function publicAgentLimitError() {
  return conflict(
    "This organization has reached the maximum number of agents (7). Delete an existing agent before making this agent public.",
  );
}

function buildAgentUpsertConflictSet(body: AgentUpdateBody, updatedAt: Date) {
  return {
    updatedAt,
    ...(body.displayName !== undefined && { displayName: body.displayName }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.sound !== undefined && { sound: body.sound }),
    ...(body.avatarUrl !== undefined && { avatarUrl: body.avatarUrl }),
    ...(body.customSkills !== undefined && {
      customSkills: [...body.customSkills],
    }),
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    ...(body.visibility !== undefined && { visibility: body.visibility }),
  };
}

async function validateCustomSkills(
  writeDb: Db,
  orgId: string,
  customSkills: readonly string[],
) {
  if (customSkills.length === 0) {
    return null;
  }

  for (const name of customSkills) {
    if (connectorTypeSchema.safeParse(name).success) {
      return validationError(
        `'${name}' is a built-in connector, not a custom skill. Enable it via connectors instead.`,
      );
    }
  }

  const existing = await writeDb
    .select({ name: zeroSkills.name })
    .from(zeroSkills)
    .where(
      and(
        eq(zeroSkills.orgId, orgId),
        inArray(zeroSkills.name, [...customSkills]),
      ),
    );
  const existingNames = new Set(
    existing.map((skill) => {
      return skill.name;
    }),
  );
  const missing = customSkills.find((name) => {
    return !existingNames.has(name);
  });

  return missing
    ? validationError(
        `Custom skill '${missing}' not found in this organization. Create it with 'zero skill create' first.`,
      )
    : null;
}

function findAgentForUpdate(
  writeDb: Db,
  orgId: string,
  agentId: string,
): Promise<ExistingAgentForUpdate | null> {
  return writeDb
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      customSkills: zeroAgents.customSkills,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(agentComposes)
    .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
    .where(and(eq(agentComposes.orgId, orgId), eq(agentComposes.id, agentId)))
    .limit(1)
    .then((rows) => {
      return rows[0] ?? null;
    });
}

function findAgentMetadataForUpdate(
  writeDb: Db,
  orgId: string,
  agentId: string,
) {
  return writeDb
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.id, agentId)))
    .limit(1)
    .then((rows) => {
      return rows[0] ?? null;
    });
}

function requireAgentConfigurationPermission(
  existing: ExistingAgentForUpdate,
  member: AgentMember,
) {
  return existing.owner
    ? requireAgentPermission(
        existing.owner,
        member,
        "update agent configuration",
        { visibility: existing.visibility },
      )
    : requireAdminPermission(member, "update agent configuration");
}

function visibilityOwnerError(
  existing: ExistingAgentVisibility,
  member: AgentMember,
  requestedVisibility: ZeroAgentVisibility | undefined,
) {
  if (
    requestedVisibility === undefined ||
    !existing.owner ||
    existing.owner === member.userId
  ) {
    return null;
  }

  return forbidden("Only the agent owner can update agent visibility");
}

async function privateVisibilityError(args: {
  readonly get: SignalGetter;
  readonly orgId: string;
  readonly userId: string;
  readonly nextVisibility: ZeroAgentVisibility;
  readonly signal: AbortSignal;
}) {
  if (args.nextVisibility !== "private") {
    return null;
  }

  const overrides = await args.get(
    userFeatureSwitchOverrides(args.orgId, args.userId),
  );
  args.signal.throwIfAborted();
  const enabled = isFeatureEnabled(FeatureSwitchKey.PrivateAgents, {
    orgId: args.orgId,
    userId: args.userId,
    overrides,
  });

  return enabled
    ? null
    : forbidden("Private agents are not available for this account");
}

async function publicVisibilitySlotError(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly currentVisibility: ZeroAgentVisibility | null;
  readonly nextVisibility: ZeroAgentVisibility;
  readonly signal: AbortSignal;
}) {
  if (args.nextVisibility !== "public" || args.currentVisibility === "public") {
    return null;
  }

  const [publicAgentCount] = await args.writeDb
    .select({ value: count() })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, args.orgId),
        eq(zeroAgents.visibility, "public"),
      ),
    );
  args.signal.throwIfAborted();

  return (publicAgentCount?.value ?? 0) >= PUBLIC_AGENT_LIMIT
    ? publicAgentLimitError()
    : null;
}

async function validateAgentVisibilityUpdate(args: {
  readonly get: SignalGetter;
  readonly writeDb: Db;
  readonly orgId: string;
  readonly member: AgentMember;
  readonly existing: ExistingAgentVisibility;
  readonly requestedVisibility: ZeroAgentVisibility | undefined;
  readonly nextVisibility: ZeroAgentVisibility;
  readonly signal: AbortSignal;
}) {
  const ownerError = visibilityOwnerError(
    args.existing,
    args.member,
    args.requestedVisibility,
  );
  if (ownerError) {
    return ownerError;
  }

  return (
    (await privateVisibilityError({
      get: args.get,
      orgId: args.orgId,
      userId: args.member.userId,
      nextVisibility: args.nextVisibility,
      signal: args.signal,
    })) ??
    (await publicVisibilitySlotError({
      writeDb: args.writeDb,
      orgId: args.orgId,
      currentVisibility: args.existing.visibility,
      nextVisibility: args.nextVisibility,
      signal: args.signal,
    }))
  );
}

async function validateCustomSkillsForUpdate(args: {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly requestedCustomSkills: readonly string[] | undefined;
  readonly customSkills: readonly string[];
  readonly signal: AbortSignal;
}) {
  if (args.requestedCustomSkills === undefined) {
    return null;
  }

  const error = await validateCustomSkills(
    args.writeDb,
    args.orgId,
    args.customSkills,
  );
  args.signal.throwIfAborted();
  return error;
}

function upsertZeroAgentAfterCompose(
  writeDb: Db,
  args: {
    readonly composeId: string;
    readonly orgId: string;
    readonly name: string;
    readonly owner: string;
    readonly body: AgentUpdateBody;
    readonly customSkills: readonly string[];
    readonly visibility: ZeroAgentVisibility;
  },
) {
  return writeDb
    .insert(zeroAgents)
    .values({
      id: args.composeId,
      orgId: args.orgId,
      name: args.name,
      owner: args.owner,
      displayName: args.body.displayName ?? null,
      description: args.body.description ?? null,
      sound: args.body.sound ?? null,
      avatarUrl: args.body.avatarUrl ?? null,
      customSkills: [...args.customSkills],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: args.visibility,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: buildAgentUpsertConflictSet(args.body, nowDate()),
    });
}

function readAgentForResponse(writeDb: Db, orgId: string, agentId: string) {
  return writeDb
    .select({
      agentId: zeroAgents.id,
      owner: zeroAgents.owner,
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
      avatarUrl: zeroAgents.avatarUrl,
      permissionPolicies: zeroAgents.permissionPolicies,
      unknownPermissionPolicies: zeroAgents.unknownPermissionPolicies,
      customSkills: zeroAgents.customSkills,
      modelProviderId: zeroAgents.modelProviderId,
      selectedModel: zeroAgents.selectedModel,
      preferPersonalProvider: zeroAgents.preferPersonalProvider,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.id, agentId)))
    .limit(1)
    .then((rows) => {
      return rows[0] ?? null;
    });
}

const listAgentsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const agents = await get(zeroAgentList(auth.orgId, auth.userId));
  return { status: 200 as const, body: [...agents] };
});

const getAgentInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentsByIdContract.get));
  const agent = await get(
    zeroAgentDetail({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!agent) {
    return agentNotFound(params.id);
  }
  return { status: 200 as const, body: agent };
});

const getAgentUserConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroUserConnectorsContract.get));
  const exists = await get(
    zeroAgentExists({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const enabledTypes = await get(
    zeroAgentEnabledConnectorTypes({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  return { status: 200 as const, body: { enabledTypes: [...enabledTypes] } };
});

const getAgentCustomConnectorsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroAgentCustomConnectorsContract.get));
  const exists = await get(
    zeroAgentExists({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  if (!exists) {
    return agentNotFound(params.id);
  }

  const enabledIds = await get(
    zeroAgentEnabledCustomConnectorIds({
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: params.id,
    }),
  );
  return { status: 200 as const, body: { enabledIds: [...enabledIds] } };
});

const updateAgentCustomConnectorsBody$ = bodyResultOf(
  zeroAgentCustomConnectorsContract.update,
);

const updateAgentBody$ = bodyResultOf(zeroAgentsByIdContract.update);

const updateAgentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
  const params = get(pathParamsOf(zeroAgentsByIdContract.update));
  const body = await get(updateAgentBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const writeDb = set(writeDb$);
  const existing = await findAgentForUpdate(writeDb, auth.orgId, params.id);
  signal.throwIfAborted();
  if (!existing) {
    return agentNotFound(params.id);
  }

  const permissionError = requireAgentConfigurationPermission(existing, member);
  if (permissionError) {
    return permissionError;
  }

  const nextVisibility =
    body.data.visibility ?? existing.visibility ?? "public";
  const visibilityError = await validateAgentVisibilityUpdate({
    get,
    writeDb,
    orgId: auth.orgId,
    member,
    existing,
    requestedVisibility: body.data.visibility,
    nextVisibility,
    signal,
  });
  if (visibilityError) {
    return visibilityError;
  }

  const customSkills = body.data.customSkills ?? existing.customSkills ?? [];
  const customSkillsError = await validateCustomSkillsForUpdate({
    writeDb,
    orgId: auth.orgId,
    requestedCustomSkills: body.data.customSkills,
    customSkills,
    signal,
  });
  if (customSkillsError) {
    return customSkillsError;
  }

  const result = await set(
    serverSideZeroAgentCompose$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      agentComposeId: existing.id,
      agentName: existing.name,
    },
    signal,
  );
  signal.throwIfAborted();

  await upsertZeroAgentAfterCompose(writeDb, {
    composeId: result.composeId,
    orgId: auth.orgId,
    name: result.composeName,
    owner: auth.userId,
    body: body.data,
    customSkills,
    visibility: nextVisibility,
  });
  signal.throwIfAborted();

  const agent = await readAgentForResponse(writeDb, auth.orgId, params.id);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: agent
      ? agentResponse(agent)
      : defaultAgentResponse({ agentId: params.id, ownerId: auth.userId }),
  };
});

const updateAgentMetadataBody$ = bodyResultOf(
  zeroAgentsByIdContract.updateMetadata,
);

const updateAgentMetadataInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
    const params = get(pathParamsOf(zeroAgentsByIdContract.updateMetadata));
    const body = await get(updateAgentMetadataBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const existing = await findAgentMetadataForUpdate(
      writeDb,
      auth.orgId,
      params.id,
    );
    signal.throwIfAborted();
    if (!existing) {
      return agentNotFound(params.id);
    }

    const permissionError = requireAgentPermission(
      existing.owner,
      member,
      "update agent profile",
      { visibility: existing.visibility },
    );
    if (permissionError) {
      return permissionError;
    }

    if (body.data.visibility !== undefined) {
      const visibilityError = await validateAgentVisibilityUpdate({
        get,
        writeDb,
        orgId: auth.orgId,
        member,
        existing,
        requestedVisibility: body.data.visibility,
        nextVisibility: body.data.visibility,
        signal,
      });
      if (visibilityError) {
        return visibilityError;
      }
    }

    await writeDb
      .update(zeroAgents)
      .set(buildAgentUpsertConflictSet(body.data, nowDate()))
      .where(eq(zeroAgents.id, params.id));
    signal.throwIfAborted();

    const agent = await readAgentForResponse(writeDb, auth.orgId, params.id);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: agent
        ? agentResponse(agent)
        : defaultAgentResponse({ agentId: params.id, ownerId: auth.userId }),
    };
  },
);

const deleteAgentInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const member = { userId: auth.userId, role: auth.orgRole ?? "member" };
  const params = get(pathParamsOf(zeroAgentsByIdContract.delete));

  const writeDb = set(writeDb$);
  const [agent] = await writeDb
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      owner: zeroAgents.owner,
      visibility: zeroAgents.visibility,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, auth.orgId), eq(zeroAgents.id, params.id)))
    .limit(1);
  signal.throwIfAborted();

  if (!agent) {
    return agentNotFound(params.id);
  }

  const permissionError = requireAgentPermission(
    agent.owner,
    member,
    "delete agent",
    { visibility: agent.visibility },
  );
  if (permissionError) {
    return permissionError;
  }

  const result = await set(
    deleteComposeById$,
    { composeId: agent.id, composeName: agent.name, orgId: auth.orgId },
    signal,
  );
  signal.throwIfAborted();

  if (result?.status === 409) {
    return result;
  }

  return { status: 204 as const, body: undefined };
});

const updateAgentCustomConnectorsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroAgentCustomConnectorsContract.update));
    const body = await get(updateAgentCustomConnectorsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const exists = await get(
      zeroAgentExists({
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: params.id,
      }),
    );
    signal.throwIfAborted();
    if (!exists) {
      return agentNotFound(params.id);
    }

    const writeDb = set(writeDb$);
    const enabledIds = body.data.enabledIds;

    if (enabledIds.length > 0) {
      const found = await writeDb
        .select({ id: orgCustomConnectors.id })
        .from(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.orgId, auth.orgId),
            inArray(orgCustomConnectors.id, enabledIds),
          ),
        );
      signal.throwIfAborted();
      const foundSet = new Set(
        found.map((row) => {
          return row.id;
        }),
      );
      const missing = enabledIds.filter((id) => {
        return !foundSet.has(id);
      });
      if (missing.length > 0) {
        return {
          status: 400 as const,
          body: {
            error: {
              message: `Unknown custom connector ids: ${missing.join(", ")}`,
              code: "VALIDATION_ERROR",
            },
          },
        };
      }
    }

    await writeDb.transaction(async (tx) => {
      await tx
        .delete(userCustomConnectors)
        .where(
          and(
            eq(userCustomConnectors.orgId, auth.orgId),
            eq(userCustomConnectors.userId, auth.userId),
            eq(userCustomConnectors.agentId, params.id),
          ),
        );

      if (enabledIds.length > 0) {
        await tx.insert(userCustomConnectors).values(
          enabledIds.map((customConnectorId) => {
            return {
              orgId: auth.orgId,
              userId: auth.userId,
              agentId: params.id,
              customConnectorId,
            };
          }),
        );
      }
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { enabledIds: [...enabledIds] },
    };
  },
);

const updateAgentUserConnectorsBody$ = bodyResultOf(
  zeroUserConnectorsContract.update,
);

const updateAgentUserConnectorsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(zeroUserConnectorsContract.update));
    const body = await get(updateAgentUserConnectorsBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const writeDb = set(writeDb$);
    const [agent] = await writeDb
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .leftJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(
        and(
          eq(agentComposes.orgId, auth.orgId),
          eq(agentComposes.id, params.id),
          visibleJoinedZeroAgentCondition(auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!agent) {
      return agentNotFound(params.id);
    }

    const uniqueTypes = Array.from(new Set(body.data.enabledTypes));
    const invalidTypes = uniqueTypes.filter((t) => {
      return !connectorTypeSchema.safeParse(t).success;
    });
    if (invalidTypes.length > 0) {
      return {
        status: 400 as const,
        body: {
          error: {
            message: `Invalid connector types: ${invalidTypes.join(", ")}`,
            code: "VALIDATION_ERROR",
          },
        },
      };
    }

    await writeDb.transaction(async (tx) => {
      await tx
        .delete(userConnectors)
        .where(
          and(
            eq(userConnectors.orgId, auth.orgId),
            eq(userConnectors.userId, auth.userId),
            eq(userConnectors.agentId, params.id),
          ),
        );

      if (uniqueTypes.length > 0) {
        await tx.insert(userConnectors).values(
          uniqueTypes.map((connectorType) => {
            return {
              orgId: auth.orgId,
              userId: auth.userId,
              agentId: params.id,
              connectorType,
            };
          }),
        );
      }
    });
    signal.throwIfAborted();

    await set(
      recomposeAgentIfStale$,
      {
        userId: auth.userId,
        agentComposeId: agent.id,
        agentName: agent.name,
        currentHeadVersionId: agent.headVersionId,
      },
      signal,
    );

    return {
      status: 200 as const,
      body: { enabledTypes: uniqueTypes },
    };
  },
);

const agentReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const agentWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

const agentDeleteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:delete",
} as const;

export const zeroAgentsRoutes: readonly RouteEntry[] = [
  {
    route: zeroAgentsMainContract.list,
    handler: authRoute(agentReadAuth, listAgentsInner$),
  },
  {
    route: zeroAgentsByIdContract.get,
    handler: authRoute(agentReadAuth, getAgentInner$),
  },
  {
    route: zeroAgentsByIdContract.update,
    handler: authRoute(agentWriteAuth, updateAgentInner$),
  },
  {
    route: zeroAgentsByIdContract.updateMetadata,
    handler: authRoute(agentWriteAuth, updateAgentMetadataInner$),
  },
  {
    route: zeroAgentsByIdContract.delete,
    handler: authRoute(agentDeleteAuth, deleteAgentInner$),
  },
  {
    route: zeroUserConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentUserConnectorsInner$),
  },
  {
    route: zeroAgentCustomConnectorsContract.get,
    handler: authRoute(agentReadAuth, getAgentCustomConnectorsInner$),
  },
  {
    route: zeroAgentCustomConnectorsContract.update,
    handler: authRoute(agentReadAuth, updateAgentCustomConnectorsInner$),
  },
  {
    route: zeroUserConnectorsContract.update,
    handler: authRoute(agentReadAuth, updateAgentUserConnectorsInner$),
  },
];
