import { userPermissionGrantActionSchema } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  type ZeroWorkflowVisibility,
  zeroWorkflowVisibilitySchema,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type {
  FirewallPermissionGrant,
  FirewallPermissionGrantAction,
} from "@vm0/connectors/firewall-metadata";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { userCache } from "@vm0/db/schema/user-cache";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userCustomConnectors } from "@vm0/db/schema/user-custom-connector";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { zeroWorkflows } from "@vm0/db/schema/zero-workflow";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import type { ReadonlyDb } from "../external/db";
import {
  agentConnectorScopeFromRows,
  type AgentConnectorScope,
  type AgentConnectorTypeRow,
  type AgentCustomConnectorRow,
} from "./agent-connector-scope.service";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
  type UserFeatureSwitchOverrideRow,
} from "./feature-switches.service";
import { activeUserPermissionGrantCondition } from "./zero-user-permission-grants.service";
import {
  workflowsForRunFromRows,
  type RunWorkflowRef,
  type RunWorkflowSourceRow,
} from "./zero-workflow-data.service";

const promptSnapshotRowKindSchema = z.enum(["user_info", "feature_switch"]);
type PromptSnapshotRowKind = z.output<typeof promptSnapshotRowKindSchema>;
const promptSnapshotRowKindDecoder = zodEnumDriverValueDecoder(
  promptSnapshotRowKindSchema,
);
const promptSnapshotSwitchesDecoder = zodDriverValueDecoder(
  z.record(z.string(), z.boolean()),
);

interface PromptSnapshotQueryRow {
  readonly kind: PromptSnapshotRowKind;
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly featureUserId: string | null;
  readonly switches: Record<string, boolean> | null;
}

const executionScopeSnapshotRowKindSchema = z.enum([
  "builtin_connector",
  "custom_connector",
  "workflow",
  "permission_grant",
  "trigger_agent",
]);
type ExecutionScopeSnapshotRowKind = z.output<
  typeof executionScopeSnapshotRowKindSchema
>;
const executionScopeSnapshotRowKindDecoder = zodEnumDriverValueDecoder(
  executionScopeSnapshotRowKindSchema,
);
const workflowVisibilityDecoder = zodEnumDriverValueDecoder(
  zeroWorkflowVisibilitySchema,
);
const permissionGrantActionDecoder = zodEnumDriverValueDecoder(
  userPermissionGrantActionSchema,
);
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);
const nullablePromptSnapshotSwitchesDecoder = nullableDriverValueDecoder(
  promptSnapshotSwitchesDecoder,
);
const nullableWorkflowVisibilityDecoder = nullableDriverValueDecoder(
  workflowVisibilityDecoder,
);
const nullablePermissionGrantActionDecoder = nullableDriverValueDecoder(
  permissionGrantActionDecoder,
);
const nullableTimestampDecoder = nullableDriverValueDecoder(
  zeroWorkflows.createdAt,
);

interface ExecutionScopeSnapshotQueryRow {
  readonly kind: ExecutionScopeSnapshotRowKind;
  readonly id: string | null;
  readonly name: string | null;
  readonly detail: string | null;
  readonly visibility: ZeroWorkflowVisibility | null;
  readonly ownerUserId: string | null;
  readonly action: FirewallPermissionGrantAction | null;
  readonly createdAt: Date | null;
}

export interface UserInfo {
  readonly name: string | null;
  readonly email: string | null;
  readonly timezone: string | null;
  readonly slackDisplayName?: string;
  readonly slackUserId?: string;
  readonly teamsUserDisplayName?: string;
  readonly teamsUserPrincipalName?: string;
  readonly teamsUserId?: string;
  readonly telegramDisplayName?: string;
  readonly telegramUsername?: string;
  readonly telegramUserId?: string;
  readonly telegramLanguage?: string;
  readonly agentphoneHandle?: string;
}

interface ZeroRunPromptContext {
  readonly userInfo: UserInfo;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly zeroScrapeEnabled: boolean;
  readonly zeroWebSearchEnabled: boolean;
  readonly zeroMailEnabled: boolean;
}

interface ZeroRunExecutionScopeContext extends AgentConnectorScope {
  readonly workflows: readonly RunWorkflowRef[];
  readonly permissionGrants: readonly FirewallPermissionGrant[];
  readonly triggerAgentId: string | undefined;
}

interface ExecutionScopeSnapshotArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly triggerRunId: string | undefined;
  readonly checkedAt: Date;
}

export async function loadZeroRunPromptContextSnapshot(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<ZeroRunPromptContext> {
  const userInfoQuery = db
    .select({
      kind: sql`'user_info'`.mapWith(promptSnapshotRowKindDecoder).as("kind"),
      name: userCache.name,
      email: sql`${userCache.email}`.mapWith(nullableTextDecoder).as("email"),
      timezone: orgMembersMetadata.timezone,
      featureUserId: sql`NULL::text`
        .mapWith(nullableTextDecoder)
        .as("feature_user_id"),
      switches: sql`NULL::jsonb`
        .mapWith(nullablePromptSnapshotSwitchesDecoder)
        .as("switches"),
    })
    .from(userCache)
    .leftJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.userId, args.userId),
        eq(orgMembersMetadata.orgId, args.orgId),
      ),
    )
    .where(eq(userCache.userId, args.userId));
  const featureSwitchQuery = db
    .select({
      kind: sql`'feature_switch'`
        .mapWith(promptSnapshotRowKindDecoder)
        .as("kind"),
      name: sql`NULL::text`.mapWith(nullableTextDecoder).as("name"),
      email: sql`NULL::text`.mapWith(nullableTextDecoder).as("email"),
      timezone: sql`NULL::text`.mapWith(nullableTextDecoder).as("timezone"),
      featureUserId: sql`${userFeatureSwitches.userId}`
        .mapWith(nullableTextDecoder)
        .as("feature_user_id"),
      switches: sql`${userFeatureSwitches.switches}`
        .mapWith(nullablePromptSnapshotSwitchesDecoder)
        .as("switches"),
    })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, args.orgId),
        inArray(userFeatureSwitches.userId, [
          args.userId,
          ORG_SENTINEL_USER_ID,
        ]),
      ),
    );
  const rows: PromptSnapshotQueryRow[] = await unionAll(
    userInfoQuery,
    featureSwitchQuery,
  );

  let userInfo: UserInfo = {
    name: null,
    email: null,
    timezone: null,
  };
  const featureSwitchRows: UserFeatureSwitchOverrideRow[] = [];
  for (const row of rows) {
    if (row.kind === "user_info") {
      userInfo = {
        name: row.name,
        email: row.email,
        timezone: row.timezone,
      };
      continue;
    }
    if (row.featureUserId === null || row.switches === null) {
      throw new Error("Invalid Zero prompt snapshot feature-switch row");
    }
    featureSwitchRows.push({
      userId: row.featureUserId,
      switches: row.switches,
    });
  }

  const featureSwitchContext: FeatureSwitchContext = {
    orgId: args.orgId,
    userId: args.userId,
    overrides: userFeatureSwitchOverridesFromRows(
      featureSwitchRows,
      args.userId,
    ),
  };
  return {
    userInfo,
    featureSwitchContext,
    zeroScrapeEnabled: isFeatureEnabled(
      FeatureSwitchKey.ZeroScrape,
      featureSwitchContext,
    ),
    zeroWebSearchEnabled: isFeatureEnabled(
      FeatureSwitchKey.ZeroWebSearch,
      featureSwitchContext,
    ),
    zeroMailEnabled: isFeatureEnabled(
      FeatureSwitchKey.ZeroMail,
      featureSwitchContext,
    ),
  };
}

function emptyExecutionScopeSnapshotFields() {
  return {
    id: sql`NULL::text`.mapWith(nullableTextDecoder).as("id"),
    name: sql`NULL::text`.mapWith(nullableTextDecoder).as("name"),
    detail: sql`NULL::text`.mapWith(nullableTextDecoder).as("detail"),
    visibility: sql`NULL::text`
      .mapWith(nullableWorkflowVisibilityDecoder)
      .as("visibility"),
    ownerUserId: sql`NULL::text`
      .mapWith(nullableTextDecoder)
      .as("owner_user_id"),
    action: sql`NULL::text`
      .mapWith(nullablePermissionGrantActionDecoder)
      .as("action"),
    createdAt: sql`NULL::timestamp`
      .mapWith(nullableTimestampDecoder)
      .as("created_at"),
  };
}

async function queryZeroRunExecutionScopeSnapshot(
  db: ReadonlyDb,
  args: ExecutionScopeSnapshotArgs,
): Promise<ExecutionScopeSnapshotQueryRow[]> {
  const builtinConnectorQuery = db
    .select({
      kind: sql`'builtin_connector'`
        .mapWith(executionScopeSnapshotRowKindDecoder)
        .as("kind"),
      ...emptyExecutionScopeSnapshotFields(),
      name: sql`${userConnectors.connectorType}`
        .mapWith(nullableTextDecoder)
        .as("name"),
    })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, args.agentId),
      ),
    );
  const customConnectorQuery = db
    .select({
      kind: sql`'custom_connector'`
        .mapWith(executionScopeSnapshotRowKindDecoder)
        .as("kind"),
      ...emptyExecutionScopeSnapshotFields(),
      id: sql`${userCustomConnectors.customConnectorId}::text`
        .mapWith(nullableTextDecoder)
        .as("id"),
    })
    .from(userCustomConnectors)
    .where(
      and(
        eq(userCustomConnectors.orgId, args.orgId),
        eq(userCustomConnectors.userId, args.userId),
        eq(userCustomConnectors.agentId, args.agentId),
      ),
    );
  const workflowQuery = db
    .select({
      kind: sql`'workflow'`
        .mapWith(executionScopeSnapshotRowKindDecoder)
        .as("kind"),
      ...emptyExecutionScopeSnapshotFields(),
      id: sql`${zeroWorkflows.id}::text`.mapWith(nullableTextDecoder).as("id"),
      name: sql`${zeroWorkflows.name}`.mapWith(nullableTextDecoder).as("name"),
      visibility: sql`${zeroWorkflows.visibility}`
        .mapWith(nullableWorkflowVisibilityDecoder)
        .as("visibility"),
      ownerUserId: sql`${zeroWorkflows.ownerUserId}`
        .mapWith(nullableTextDecoder)
        .as("owner_user_id"),
      createdAt: sql`${zeroWorkflows.createdAt}`
        .mapWith(nullableTimestampDecoder)
        .as("created_at"),
    })
    .from(zeroWorkflows)
    .where(
      and(
        eq(zeroWorkflows.orgId, args.orgId),
        eq(zeroWorkflows.agentId, args.agentId),
        or(
          eq(zeroWorkflows.visibility, "public"),
          eq(zeroWorkflows.ownerUserId, args.userId),
        ),
      ),
    );
  const permissionGrantQuery = db
    .select({
      kind: sql`'permission_grant'`
        .mapWith(executionScopeSnapshotRowKindDecoder)
        .as("kind"),
      ...emptyExecutionScopeSnapshotFields(),
      name: sql`${userPermissionGrants.connectorRef}`
        .mapWith(nullableTextDecoder)
        .as("name"),
      detail: sql`${userPermissionGrants.permission}`
        .mapWith(nullableTextDecoder)
        .as("detail"),
      action: sql`${userPermissionGrants.action}`
        .mapWith(nullablePermissionGrantActionDecoder)
        .as("action"),
    })
    .from(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.orgId, args.orgId),
        eq(userPermissionGrants.userId, args.userId),
        eq(userPermissionGrants.agentId, args.agentId),
        activeUserPermissionGrantCondition(args.checkedAt),
      ),
    );
  const triggerAgentQuery = db
    .select({
      kind: sql`'trigger_agent'`
        .mapWith(executionScopeSnapshotRowKindDecoder)
        .as("kind"),
      ...emptyExecutionScopeSnapshotFields(),
      id: sql`${agentSessions.agentComposeId}::text`
        .mapWith(nullableTextDecoder)
        .as("id"),
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(
      args.triggerRunId ? eq(agentRuns.id, args.triggerRunId) : sql`FALSE`,
    );
  return await unionAll(
    builtinConnectorQuery,
    customConnectorQuery,
    workflowQuery,
    permissionGrantQuery,
    triggerAgentQuery,
  );
}

function zeroRunExecutionScopeContextFromRows(
  rows: readonly ExecutionScopeSnapshotQueryRow[],
  userId: string,
): ZeroRunExecutionScopeContext {
  const connectorRows: AgentConnectorTypeRow[] = [];
  const customConnectorRows: AgentCustomConnectorRow[] = [];
  const workflowRows: RunWorkflowSourceRow[] = [];
  const permissionGrants: FirewallPermissionGrant[] = [];
  let triggerAgentId: string | undefined;

  for (const row of rows) {
    switch (row.kind) {
      case "builtin_connector": {
        if (row.name === null) {
          throw new Error("Invalid Zero execution snapshot connector row");
        }
        connectorRows.push({ connectorType: row.name });
        break;
      }
      case "custom_connector": {
        if (row.id === null) {
          throw new Error(
            "Invalid Zero execution snapshot custom connector row",
          );
        }
        customConnectorRows.push({ customConnectorId: row.id });
        break;
      }
      case "workflow": {
        if (
          row.id === null ||
          row.name === null ||
          row.visibility === null ||
          row.ownerUserId === null ||
          row.createdAt === null
        ) {
          throw new Error("Invalid Zero execution snapshot workflow row");
        }
        workflowRows.push({
          id: row.id,
          name: row.name,
          visibility: row.visibility,
          ownerUserId: row.ownerUserId,
          createdAt: row.createdAt,
        });
        break;
      }
      case "permission_grant": {
        if (row.name === null || row.detail === null || row.action === null) {
          throw new Error(
            "Invalid Zero execution snapshot permission grant row",
          );
        }
        permissionGrants.push({
          connectorRef: row.name,
          permission: row.detail,
          action: row.action,
        });
        break;
      }
      case "trigger_agent": {
        if (row.id === null) {
          throw new Error("Invalid Zero execution snapshot trigger agent row");
        }
        triggerAgentId = row.id;
        break;
      }
    }
  }

  permissionGrants.sort((left, right) => {
    return (
      left.connectorRef.localeCompare(right.connectorRef) ||
      left.permission.localeCompare(right.permission)
    );
  });
  const connectorScope = agentConnectorScopeFromRows({
    connectorRows,
    customConnectorRows,
  });
  return {
    ...connectorScope,
    workflows: workflowsForRunFromRows(workflowRows, userId),
    permissionGrants,
    triggerAgentId,
  };
}

export async function loadZeroRunExecutionScopeSnapshot(
  db: ReadonlyDb,
  args: ExecutionScopeSnapshotArgs,
): Promise<ZeroRunExecutionScopeContext> {
  const rows = await queryZeroRunExecutionScopeSnapshot(db, args);
  return zeroRunExecutionScopeContextFromRows(rows, args.userId);
}
