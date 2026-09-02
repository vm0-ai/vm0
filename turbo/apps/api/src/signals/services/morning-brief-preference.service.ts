import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
  type MorningBriefPreferenceErrorCode,
  type MorningBriefPreferenceResponse,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isValidTimeZone } from "@okouai/core/timezone";
import { agents } from "@okouai/db/schema/agent";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { delay } from "signal-timers";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import {
  installOfficialWorkflow$,
  loadOfficialWorkflowUserTimezone,
} from "./official-workflow-installation.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { reconcileOfficialWorkflowInstallation$ } from "./official-workflow-reconciliation.service";
import {
  disableWorkflowAutomation$,
  enableWorkflowAutomation$,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";

const MORNING_BRIEF_LOCK_RETRY_MS = 25;

export type MorningBriefPreferenceFailure = {
  readonly kind: "bad-request" | "conflict";
  readonly code: MorningBriefPreferenceErrorCode;
  readonly message: string;
};

type MorningBriefPreferenceResult =
  | {
      readonly kind: "ok";
      readonly preference: MorningBriefPreferenceResponse;
    }
  | MorningBriefPreferenceFailure;

interface MorningBriefPreferenceArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
}

interface MorningBriefPreferenceMutationArgs extends MorningBriefPreferenceArgs {
  readonly enabled: boolean;
  readonly publicBrand: PublicBrand;
}

interface EnsureMorningBriefDefaultEnabledArgs extends MorningBriefPreferenceArgs {
  readonly publicBrand: PublicBrand;
}

export type EnsureMorningBriefDefaultEnabledResult =
  | {
      readonly outcome: "installed";
      readonly workflowId: string;
    }
  | {
      readonly outcome: "unchanged";
      readonly reason: "existing-installation";
      readonly installationCount: number;
    }
  | {
      readonly outcome: "skipped";
      readonly reason:
        | "not-admin"
        | "not-eligible"
        | "feature-disabled"
        | "missing-timezone"
        | "missing-default-agent";
    }
  | {
      readonly outcome: "failed";
      readonly reason: "installation-failed";
      readonly failureKind:
        | "bad-request"
        | "not-found"
        | "forbidden"
        | "conflict";
      readonly message: string;
    };

function conflict(
  code: Extract<
    MorningBriefPreferenceErrorCode,
    "MORNING_BRIEF_MULTIPLE_INSTALLATIONS" | "MORNING_BRIEF_STATE_CONFLICT"
  >,
  message: string,
): MorningBriefPreferenceFailure {
  return { kind: "conflict", code, message };
}

function unavailableFailure(
  reason: NonNullable<MorningBriefPreferenceResponse["unavailableReason"]>,
): MorningBriefPreferenceFailure {
  return reason === "missing-timezone"
    ? {
        kind: "bad-request",
        code: "MORNING_BRIEF_MISSING_TIMEZONE",
        message: "Set a valid time zone before enabling Morning Brief.",
      }
    : {
        kind: "bad-request",
        code: "MORNING_BRIEF_MISSING_DEFAULT_AGENT",
        message: "Choose a usable default Agent before enabling Morning Brief.",
      };
}

async function loadUnavailableReason(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<MorningBriefPreferenceResponse["unavailableReason"]> {
  const timezone = await loadOfficialWorkflowUserTimezone(db, {
    orgId: args.orgId,
    userId: args.member.userId,
  });
  if (timezone === null || !isValidTimeZone(timezone)) {
    return "missing-timezone";
  }

  const [defaultAgent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(orgMetadata)
    .leftJoin(
      agents,
      and(
        eq(agents.id, orgMetadata.defaultAgentId),
        eq(agents.orgId, orgMetadata.orgId),
      ),
    )
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  const usable =
    defaultAgent?.id !== null &&
    defaultAgent?.id !== undefined &&
    (defaultAgent.visibility === "public" ||
      defaultAgent.owner === args.member.userId);
  return usable ? null : "missing-default-agent";
}

async function loadDefaultAgentId(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<string | null> {
  const [defaultAgent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(orgMetadata)
    .leftJoin(
      agents,
      and(
        eq(agents.id, orgMetadata.defaultAgentId),
        eq(agents.orgId, orgMetadata.orgId),
      ),
    )
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  if (
    !defaultAgent?.id ||
    (defaultAgent.visibility === "private" &&
      defaultAgent.owner !== args.member.userId)
  ) {
    return null;
  }
  return defaultAgent.id;
}

async function loadMorningBriefWorkflowIds(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<
  readonly {
    readonly id: string;
    readonly installationState: "installing" | "installed" | null;
  }[]
> {
  return await db
    .select({
      id: workflows.id,
      installationState: workflows.officialInstallationState,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.ownerUserId, args.member.userId),
        eq(workflows.visibility, "private"),
        eq(
          workflows.officialDefinitionName,
          MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
        ),
      ),
    );
}

async function loadInstalledPreference(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<MorningBriefPreferenceResult & { readonly workflowId?: string }> {
  const installations = await loadMorningBriefWorkflowIds(db, args);
  if (installations.length > 1) {
    return conflict(
      "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
      "Multiple Morning Brief installations exist. Resolve the conflict before changing this preference.",
    );
  }
  const installation = installations[0];
  if (!installation) {
    const [timezone, unavailableReason] = await Promise.all([
      loadOfficialWorkflowUserTimezone(db, {
        orgId: args.orgId,
        userId: args.member.userId,
      }),
      loadUnavailableReason(db, args),
    ]);
    return {
      kind: "ok",
      preference: {
        enabled: false,
        nextRunAt: null,
        timezone,
        unavailableReason,
      },
    };
  }
  if (installation.installationState !== "installed") {
    return conflict(
      "MORNING_BRIEF_STATE_CONFLICT",
      "Morning Brief installation is not ready. Retry after installation completes.",
    );
  }

  const automations = await db
    .select({
      id: workflowAutomations.id,
      enabled: workflowAutomations.enabled,
      nextRunAt: workflowAutomations.nextRunAt,
      timezone: workflowAutomations.timezone,
      kind: workflowAutomations.kind,
      scheduleType: workflowAutomations.scheduleType,
      blueprintKey: workflowAutomations.officialBlueprintKey,
      reconciliationStatus: workflowAutomations.officialReconciliationStatus,
      resultEmailEnabled: workflowAutomations.officialResultEmailEnabled,
    })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.member.userId),
        eq(workflowAutomations.workflowId, installation.id),
      ),
    );
  const automation = automations[0];
  if (
    automations.length !== 1 ||
    !automation ||
    automation.kind !== "schedule" ||
    automation.scheduleType !== "cron" ||
    automation.blueprintKey !== MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY ||
    automation.reconciliationStatus !== "current" ||
    automation.resultEmailEnabled !== true
  ) {
    return conflict(
      "MORNING_BRIEF_STATE_CONFLICT",
      "Morning Brief installation state is inconsistent. Retry after reconciliation completes.",
    );
  }
  return {
    kind: "ok",
    workflowId: installation.id,
    preference: {
      enabled: automation.enabled,
      nextRunAt: automation.nextRunAt?.toISOString() ?? null,
      timezone: automation.timezone,
      unavailableReason: null,
    },
  };
}

const lockRowSchema = z.object({ acquired: z.boolean() });

async function withMorningBriefPreferenceLock<T>(
  db: Db,
  args: MorningBriefPreferenceArgs,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  while (true) {
    const result = await db.transaction(async (tx) => {
      const rows = await executeRawRows(
        tx,
        sql`SELECT pg_try_advisory_xact_lock(
          hashtextextended(
            ${`morning_brief_preference:${args.orgId}:${args.member.userId}`},
            0
          )
        ) AS acquired`,
        lockRowSchema,
      );
      if (rows[0]?.acquired !== true) {
        return { acquired: false as const };
      }
      signal.throwIfAborted();
      return { acquired: true as const, value: await operation() };
    });
    if (result.acquired) {
      return result.value;
    }
    await delay(MORNING_BRIEF_LOCK_RETRY_MS, { signal });
  }
}

export const morningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    return await loadInstalledPreference(db, args);
  },
);

async function hasMorningBriefDefaultEligibility(
  db: ReadonlyDb,
  args: MorningBriefPreferenceArgs,
): Promise<boolean> {
  const [metadata] = await db
    .select({
      eligibleAt: orgMembersMetadata.morningBriefDefaultEligibleAt,
    })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.member.userId),
      ),
    )
    .limit(1);
  return metadata?.eligibleAt !== null && metadata?.eligibleAt !== undefined;
}

export const ensureMorningBriefDefaultEnabled$ = command(
  async (
    { set },
    args: EnsureMorningBriefDefaultEnabledArgs,
    signal: AbortSignal,
  ): Promise<EnsureMorningBriefDefaultEnabledResult> => {
    const db = set(writeDb$);
    return await withMorningBriefPreferenceLock(db, args, signal, async () => {
      const installations = await loadMorningBriefWorkflowIds(db, args);
      signal.throwIfAborted();
      if (installations.length > 0) {
        return {
          outcome: "unchanged",
          reason: "existing-installation",
          installationCount: installations.length,
        };
      }

      if (args.member.role !== "admin" && args.member.role !== "org:admin") {
        return { outcome: "skipped", reason: "not-admin" };
      }

      if (!(await hasMorningBriefDefaultEligibility(db, args))) {
        return { outcome: "skipped", reason: "not-eligible" };
      }
      signal.throwIfAborted();

      const featureSwitchContext = await loadUserFeatureSwitchContext(
        db,
        args.orgId,
        args.member.userId,
      );
      signal.throwIfAborted();
      if (
        !isFeatureEnabled(FeatureSwitchKey.MorningBrief, featureSwitchContext)
      ) {
        return { outcome: "skipped", reason: "feature-disabled" };
      }

      const unavailableReason = await loadUnavailableReason(db, args);
      signal.throwIfAborted();
      if (unavailableReason !== null) {
        return { outcome: "skipped", reason: unavailableReason };
      }

      const agentId = await loadDefaultAgentId(db, args);
      signal.throwIfAborted();
      if (agentId === null) {
        return { outcome: "skipped", reason: "missing-default-agent" };
      }

      const installed = await set(
        installOfficialWorkflow$,
        {
          orgId: args.orgId,
          member: args.member,
          agentId,
          definitionName: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
          blueprints: [
            {
              blueprintKey: MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
              bindings: [],
            },
          ],
        },
        args.publicBrand,
        signal,
      );
      signal.throwIfAborted();
      if (installed.kind === "ok") {
        return { outcome: "installed", workflowId: installed.workflowId };
      }

      const racedInstallations = await loadMorningBriefWorkflowIds(db, args);
      signal.throwIfAborted();
      if (racedInstallations.length > 0) {
        return {
          outcome: "unchanged",
          reason: "existing-installation",
          installationCount: racedInstallations.length,
        };
      }
      return {
        outcome: "failed",
        reason: "installation-failed",
        failureKind: installed.kind,
        message: installed.message,
      };
    });
  },
);

async function loadMorningBriefAutomationId(
  db: ReadonlyDb,
  workflowId: string,
): Promise<string | null> {
  const [automation] = await db
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.workflowId, workflowId),
        eq(
          workflowAutomations.officialBlueprintKey,
          MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
        ),
      ),
    )
    .limit(1);
  return automation?.id ?? null;
}

export const updateMorningBriefPreference$ = command(
  async (
    { set },
    args: MorningBriefPreferenceMutationArgs,
    signal: AbortSignal,
  ): Promise<MorningBriefPreferenceResult> => {
    const db = set(writeDb$);
    return await withMorningBriefPreferenceLock(db, args, signal, async () => {
      const installations = await loadMorningBriefWorkflowIds(db, args);
      signal.throwIfAborted();
      if (installations.length > 1) {
        return conflict(
          "MORNING_BRIEF_MULTIPLE_INSTALLATIONS",
          "Multiple Morning Brief installations exist. Resolve the conflict before changing this preference.",
        );
      }

      const installation = installations[0];
      if (!installation) {
        if (!args.enabled) {
          return await loadInstalledPreference(db, args);
        }
        const unavailableReason = await loadUnavailableReason(db, args);
        signal.throwIfAborted();
        if (unavailableReason !== null) {
          return unavailableFailure(unavailableReason);
        }
        const agentId = await loadDefaultAgentId(db, args);
        signal.throwIfAborted();
        if (agentId === null) {
          return unavailableFailure("missing-default-agent");
        }
        const installed = await set(
          installOfficialWorkflow$,
          {
            orgId: args.orgId,
            member: args.member,
            agentId,
            definitionName: MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
            blueprints: [
              {
                blueprintKey: MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
                bindings: [],
              },
            ],
          },
          args.publicBrand,
          signal,
        );
        signal.throwIfAborted();
        if (installed.kind !== "ok") {
          const raced = await loadInstalledPreference(db, args);
          signal.throwIfAborted();
          return raced.kind === "ok" && raced.workflowId
            ? raced
            : conflict(
                "MORNING_BRIEF_STATE_CONFLICT",
                "Morning Brief could not be installed. Retry the preference update.",
              );
        }
        return await loadInstalledPreference(db, args);
      }

      if (installation.installationState !== "installed") {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief installation is not ready. Retry after installation completes.",
        );
      }

      if (args.enabled) {
        const reconciliation = await set(
          reconcileOfficialWorkflowInstallation$,
          {
            orgId: args.orgId,
            member: args.member,
            workflowId: installation.id,
            publicBrand: args.publicBrand,
          },
          signal,
        );
        signal.throwIfAborted();
        if (reconciliation.kind !== "current") {
          return conflict(
            "MORNING_BRIEF_STATE_CONFLICT",
            "Morning Brief could not be reconciled. Retry the preference update.",
          );
        }
      }

      const current = await loadInstalledPreference(db, args);
      signal.throwIfAborted();
      if (current.kind !== "ok" || current.workflowId === undefined) {
        return current;
      }
      if (current.preference.enabled === args.enabled) {
        return current;
      }

      const automationId = await loadMorningBriefAutomationId(
        db,
        current.workflowId,
      );
      signal.throwIfAborted();
      if (automationId === null) {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief automation is unavailable. Retry after reconciliation completes.",
        );
      }
      const changed = await set(
        args.enabled ? enableWorkflowAutomation$ : disableWorkflowAutomation$,
        {
          orgId: args.orgId,
          member: args.member,
          automationId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (changed.kind !== "ok") {
        return conflict(
          "MORNING_BRIEF_STATE_CONFLICT",
          "Morning Brief automation could not be updated. Retry the preference update.",
        );
      }
      return await loadInstalledPreference(db, args);
    });
  },
);
