import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  workflowAutomationCreateRequestSchema,
  type WorkflowAutomationCreateRequest,
  type WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import type {
  OfficialWorkflowAcceptedBlueprint,
  OfficialWorkflowAcceptedDefinition,
  OfficialWorkflowBlueprintBindings,
  OfficialWorkflowInstallationParameter,
  OfficialWorkflowParameterBinding,
  OfficialWorkflowParameterValue,
  OfficialWorkflowTemplateJsonValue,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import type {
  OfficialWorkflowCatalogDetail,
  OfficialWorkflowCatalogSummary,
} from "@okouai/api-contracts/contracts/official-workflows";
import { isValidTimeZone, parseScheduledAtTime } from "@okouai/core/timezone";
import { agents } from "@okouai/db/schema/agent";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { strapiWorkflowAutomations } from "@okouai/db/schema/strapi-integration";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { onRejection, safeSync, settle } from "../utils";
import { reconcileAutomationEventWatchReconfiguration } from "./automation-event-watch-lifecycle.service";
import { deleteWorkflow$ } from "./workflow-delete.service";
import { OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK } from "./official-workflow-constants";
import {
  readAcceptedOfficialWorkflowCatalog,
  readAcceptedOfficialWorkflowRevision,
} from "./official-workflow-catalog-read.service";
import {
  createWorkflowAutomation$,
  prepareOfficialAutomationReconfiguration$,
  type AutomationResult,
  type CreateAutomationInput,
  type OfficialAutomationEventPreparation,
  type OfficialAutomationEventPreparationResult,
} from "./workflow-automation.service";
import type { WorkflowMember } from "./workflow-data.service";
import { calculateNextRun } from "./time-automation";

const STALE_INSTALLATION_AGE_MS = 5 * 60 * 1000;

type OfficialWorkflowFailure =
  | { readonly kind: "bad-request"; readonly message: string }
  | { readonly kind: "not-found"; readonly message: string }
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

export type OfficialWorkflowInstallResult =
  | { readonly kind: "ok"; readonly workflowId: string }
  | OfficialWorkflowFailure;
type OfficialWorkflowReconfigureResult = OfficialWorkflowInstallResult;

interface ConfigurableAgent {
  readonly id: string;
  readonly owner: string;
  readonly visibility: "public" | "private";
}

interface ResolvedBlueprint {
  readonly blueprint: OfficialWorkflowAcceptedBlueprint;
  readonly bindings: readonly OfficialWorkflowParameterBinding[];
  readonly createRequest: WorkflowAutomationCreateRequest;
  readonly autonomyBudget: number | undefined;
}

type ResolveResult =
  | { readonly ok: true; readonly blueprints: readonly ResolvedBlueprint[] }
  | { readonly ok: false; readonly message: string };

function catalogSummary(
  definition: OfficialWorkflowAcceptedDefinition,
  detail: OfficialWorkflowCatalogDetail,
): OfficialWorkflowCatalogSummary {
  return {
    name: definition.name,
    revision: definition.revision,
    displayName: detail.workflow.displayName,
    description: detail.workflow.description,
    blueprints: detail.blueprints,
    presentation: definition.presentation,
  };
}

async function activeCatalogDetail(
  db: ReadonlyDb,
  definition: OfficialWorkflowAcceptedDefinition,
  signal: AbortSignal,
): Promise<OfficialWorkflowCatalogDetail | null> {
  if (definition.lifecycle !== "active") {
    return null;
  }
  const revision = await readAcceptedOfficialWorkflowRevision(
    db,
    { name: definition.name, revision: definition.revision },
    signal,
  );
  if (!revision) {
    throw new Error(
      `Accepted Official Workflow revision is missing: ${definition.name}@${definition.revision}`,
    );
  }
  return {
    name: definition.name,
    revision: definition.revision,
    displayName: revision.definition.workflow.displayName,
    description: revision.definition.workflow.description,
    workflow: revision.definition.workflow,
    blueprints: revision.definition.blueprints,
    presentation: definition.presentation,
  };
}

export async function listActiveOfficialWorkflows(
  db: ReadonlyDb,
  signal: AbortSignal,
): Promise<readonly OfficialWorkflowCatalogSummary[]> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  if (!catalog) {
    return [];
  }
  const active = catalog.payload.definitions.filter((definition) => {
    return definition.lifecycle === "active";
  });
  const details = await Promise.all(
    active.map(async (definition) => {
      const detail = await activeCatalogDetail(db, definition, signal);
      if (!detail) {
        throw new Error("Active Official Workflow unexpectedly retired");
      }
      return catalogSummary(definition, detail);
    }),
  );
  signal.throwIfAborted();
  return details.sort((left, right) => {
    const leftOrder = left.presentation.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.presentation.order ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

export async function getActiveOfficialWorkflow(
  db: ReadonlyDb,
  name: string,
  signal: AbortSignal,
): Promise<OfficialWorkflowCatalogDetail | null> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = catalog?.payload.definitions.find((entry) => {
    return entry.name === name;
  });
  return definition ? await activeCatalogDetail(db, definition, signal) : null;
}

function isParameterReference(
  value: unknown,
): value is { readonly parameter: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "parameter" in value &&
    typeof value.parameter === "string"
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validStringParameterValue(
  parameter: Extract<
    OfficialWorkflowInstallationParameter,
    { readonly type: "string" }
  >,
  value: string,
): boolean {
  if (parameter.format === "uuid") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }
  if (parameter.format === "timezone") {
    return isValidTimeZone(value);
  }
  if (parameter.format === "date-time") {
    return z.string().datetime({ offset: true }).safeParse(value).success;
  }
  if (parameter.format === "url") {
    return URL.canParse(value);
  }
  return true;
}

function validParameterValue(
  parameter: OfficialWorkflowInstallationParameter,
  value: OfficialWorkflowParameterValue,
): boolean {
  if (parameter.type === "integer") {
    return typeof value === "number" && Number.isSafeInteger(value);
  }
  if (parameter.type === "boolean") {
    return typeof value === "boolean";
  }
  return (
    typeof value === "string" && validStringParameterValue(parameter, value)
  );
}

function resolveParameterBindings(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  supplied: OfficialWorkflowBlueprintBindings,
  userTimezone: string | null,
):
  | {
      readonly ok: true;
      readonly bindings: readonly OfficialWorkflowParameterBinding[];
    }
  | { readonly ok: false; readonly message: string } {
  const parameters = new Map(
    blueprint.parameters.map((parameter) => {
      return [parameter.key, parameter] as const;
    }),
  );
  const suppliedByKey = new Map<string, OfficialWorkflowParameterValue>();
  for (const binding of supplied.bindings) {
    if (suppliedByKey.has(binding.key)) {
      return {
        ok: false,
        message: `Duplicate parameter binding: ${blueprint.key}.${binding.key}`,
      };
    }
    const parameter = parameters.get(binding.key);
    if (!parameter) {
      return {
        ok: false,
        message: `Unknown parameter: ${blueprint.key}.${binding.key}`,
      };
    }
    if (!validParameterValue(parameter, binding.value)) {
      return {
        ok: false,
        message: `Invalid value for parameter: ${blueprint.key}.${binding.key}`,
      };
    }
    suppliedByKey.set(binding.key, binding.value);
  }

  const bindings: OfficialWorkflowParameterBinding[] = [];
  for (const parameter of blueprint.parameters) {
    let value = suppliedByKey.get(parameter.key);
    if (value === undefined && parameter.default !== undefined) {
      value = parameter.default;
    }
    if (
      value === undefined &&
      parameter.type === "string" &&
      parameter.derivation?.kind === "user-timezone"
    ) {
      if (!userTimezone || !isValidTimeZone(userTimezone)) {
        return {
          ok: false,
          message: `A valid user timezone is required for parameter: ${blueprint.key}.${parameter.key}`,
        };
      }
      value = userTimezone;
    }
    if (value === undefined) {
      if (parameter.required) {
        return {
          ok: false,
          message: `Missing parameter: ${blueprint.key}.${parameter.key}`,
        };
      }
      continue;
    }
    if (!validParameterValue(parameter, value)) {
      return {
        ok: false,
        message: `Invalid value for parameter: ${blueprint.key}.${parameter.key}`,
      };
    }
    bindings.push({ key: parameter.key, value });
  }
  return { ok: true, bindings };
}

function materializeTemplate(
  value: OfficialWorkflowTemplateJsonValue,
  bindings: ReadonlyMap<string, OfficialWorkflowParameterValue>,
):
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly parameter: string;
    } {
  if (isParameterReference(value)) {
    const resolved = bindings.get(value.parameter);
    return resolved === undefined
      ? { ok: false, parameter: value.parameter }
      : { ok: true, value: resolved };
  }
  if (Array.isArray(value)) {
    const materialized: unknown[] = [];
    for (const item of value) {
      const result = materializeTemplate(item, bindings);
      if (!result.ok) {
        return result;
      }
      materialized.push(result.value);
    }
    return { ok: true, value: materialized };
  }
  if (isJsonObject(value)) {
    const materialized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = materializeTemplate(
        item as OfficialWorkflowTemplateJsonValue,
        bindings,
      );
      if (!result.ok) {
        return result;
      }
      materialized[key] = result.value;
    }
    return { ok: true, value: materialized };
  }
  return { ok: true, value };
}

function resolveBlueprint(
  blueprint: OfficialWorkflowAcceptedBlueprint,
  supplied: OfficialWorkflowBlueprintBindings,
  userTimezone: string | null,
):
  | { readonly ok: true; readonly blueprint: ResolvedBlueprint }
  | { readonly ok: false; readonly message: string } {
  const resolvedBindings = resolveParameterBindings(
    blueprint,
    supplied,
    userTimezone,
  );
  if (!resolvedBindings.ok) {
    return resolvedBindings;
  }
  const bindingValues = new Map(
    resolvedBindings.bindings.map((binding) => {
      return [binding.key, binding.value] as const;
    }),
  );
  const desired = materializeTemplate(
    blueprint.desiredState as OfficialWorkflowTemplateJsonValue,
    bindingValues,
  );
  if (!desired.ok) {
    return {
      ok: false,
      message: `Missing parameter used by Blueprint: ${blueprint.key}.${desired.parameter}`,
    };
  }
  if (!isJsonObject(desired.value)) {
    return { ok: false, message: `Invalid Blueprint: ${blueprint.key}` };
  }
  const { autonomyBudget, ...createDesiredState } = desired.value;
  if (
    autonomyBudget !== undefined &&
    (typeof autonomyBudget !== "number" ||
      !Number.isSafeInteger(autonomyBudget) ||
      autonomyBudget < 0 ||
      autonomyBudget > 10)
  ) {
    return {
      ok: false,
      message: `Invalid autonomy budget for Blueprint: ${blueprint.key}`,
    };
  }
  const parsed = workflowAutomationCreateRequestSchema.safeParse({
    ...createDesiredState,
    enabled: true,
  });
  if (!parsed.success) {
    return {
      ok: false,
      message: `Invalid desired state for Blueprint: ${blueprint.key}`,
    };
  }
  return {
    ok: true,
    blueprint: {
      blueprint,
      bindings: resolvedBindings.bindings,
      createRequest: parsed.data,
      autonomyBudget:
        typeof autonomyBudget === "number" ? autonomyBudget : undefined,
    },
  };
}

function resolveAllBlueprints(
  blueprints: readonly OfficialWorkflowAcceptedBlueprint[],
  supplied: readonly OfficialWorkflowBlueprintBindings[],
  userTimezone: string | null,
): ResolveResult {
  const suppliedByKey = new Map<string, OfficialWorkflowBlueprintBindings>();
  for (const entry of supplied) {
    if (suppliedByKey.has(entry.blueprintKey)) {
      return {
        ok: false,
        message: `Duplicate Blueprint bindings: ${entry.blueprintKey}`,
      };
    }
    suppliedByKey.set(entry.blueprintKey, entry);
  }
  const declaredKeys = new Set(
    blueprints.map((blueprint) => {
      return blueprint.key;
    }),
  );
  for (const suppliedKey of suppliedByKey.keys()) {
    if (!declaredKeys.has(suppliedKey)) {
      return { ok: false, message: `Unknown Blueprint: ${suppliedKey}` };
    }
  }
  if (suppliedByKey.size !== blueprints.length) {
    const missing = blueprints.find((blueprint) => {
      return !suppliedByKey.has(blueprint.key);
    });
    return {
      ok: false,
      message: `Missing Blueprint bindings: ${missing?.key ?? "unknown"}`,
    };
  }
  const resolved: ResolvedBlueprint[] = [];
  for (const blueprint of blueprints) {
    const entry = suppliedByKey.get(blueprint.key);
    if (!entry) {
      throw new Error("Resolved Blueprint binding disappeared");
    }
    const result = resolveBlueprint(blueprint, entry, userTimezone);
    if (!result.ok) {
      return result;
    }
    resolved.push(result.blueprint);
  }
  return { ok: true, blueprints: resolved };
}

async function loadConfigurableAgent(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly member: WorkflowMember;
  },
): Promise<ConfigurableAgent | OfficialWorkflowFailure> {
  const [agent] = await db
    .select({
      id: agents.id,
      owner: agents.owner,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(and(eq(agents.orgId, args.orgId), eq(agents.id, args.agentId)))
    .limit(1);
  if (!agent) {
    return { kind: "not-found", message: `Agent not found: ${args.agentId}` };
  }
  if (agent.visibility === "private" && agent.owner !== args.member.userId) {
    return {
      kind: "forbidden",
      message:
        "Only the private agent owner can install Official Workflows on this agent",
    };
  }
  return agent;
}

function isFailure(
  value: ConfigurableAgent | OfficialWorkflowFailure,
): value is OfficialWorkflowFailure {
  return "kind" in value;
}

async function loadUserTimezone(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ timezone: orgMembersMetadata.timezone })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, args.orgId),
        eq(orgMembersMetadata.userId, args.userId),
      ),
    )
    .limit(1);
  return row?.timezone ?? null;
}

async function recoverOrRejectExistingInstallation(
  db: Db,
  cleanup: (workflowId: string) => Promise<boolean>,
  args: {
    readonly orgId: string;
    readonly agentId: string;
    readonly userId: string;
    readonly definitionName: string;
    readonly currentTime: Date;
  },
): Promise<OfficialWorkflowFailure | null> {
  const [existing] = await db
    .select({
      id: workflows.id,
      officialDefinitionName: workflows.officialDefinitionName,
      officialInstallationState: workflows.officialInstallationState,
      createdAt: workflows.createdAt,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.agentId),
        eq(workflows.ownerUserId, args.userId),
        eq(workflows.visibility, "private"),
        eq(workflows.name, args.definitionName),
      ),
    )
    .limit(1);
  if (!existing) {
    return null;
  }
  if (
    existing.officialDefinitionName === args.definitionName &&
    existing.officialInstallationState === "installing" &&
    args.currentTime.getTime() - existing.createdAt.getTime() >=
      STALE_INSTALLATION_AGE_MS
  ) {
    return (await cleanup(existing.id))
      ? null
      : {
          kind: "conflict",
          message:
            "Official Workflow installation changed during recovery; retry",
        };
  }
  if (existing.officialInstallationState === "installing") {
    return {
      kind: "conflict",
      message: "Official Workflow installation is in progress",
    };
  }
  return {
    kind: "conflict",
    message:
      existing.officialDefinitionName === args.definitionName
        ? "Official Workflow is already installed on this agent"
        : `A private workflow named "${args.definitionName}" already exists on this agent`,
  };
}

function sameAcceptedDefinition(
  expectedReleaseId: string,
  expected: OfficialWorkflowAcceptedDefinition,
  current: Awaited<ReturnType<typeof readAcceptedOfficialWorkflowCatalog>>,
): boolean {
  if (!current || current.releaseId !== expectedReleaseId) {
    return false;
  }
  const definition = current.payload.definitions.find((entry) => {
    return entry.name === expected.name;
  });
  return (
    definition?.lifecycle === expected.lifecycle &&
    definition.revision === expected.revision &&
    definition.blueprints.length === expected.blueprints.length &&
    definition.blueprints.every((blueprint, index) => {
      const accepted = expected.blueprints[index];
      return (
        accepted !== undefined &&
        blueprint.key === accepted.key &&
        blueprint.fingerprint === accepted.fingerprint
      );
    })
  );
}

interface InstallOfficialWorkflowArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly agentId: string;
  readonly definitionName: string;
  readonly blueprints: readonly OfficialWorkflowBlueprintBindings[];
}

interface ResolvedInstallation {
  readonly catalog: NonNullable<
    Awaited<ReturnType<typeof readAcceptedOfficialWorkflowCatalog>>
  >;
  readonly definition: OfficialWorkflowAcceptedDefinition;
  readonly resolved: Extract<ResolveResult, { readonly ok: true }>;
}

async function resolveInstallation(
  db: ReadonlyDb,
  args: InstallOfficialWorkflowArgs,
  signal: AbortSignal,
): Promise<ResolvedInstallation | OfficialWorkflowFailure> {
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = catalog?.payload.definitions.find((entry) => {
    return entry.name === args.definitionName;
  });
  if (!catalog || !definition) {
    return {
      kind: "not-found",
      message: `Official Workflow not found: ${args.definitionName}`,
    };
  }
  if (definition.lifecycle !== "active") {
    return {
      kind: "conflict",
      message: `Official Workflow is retired: ${args.definitionName}`,
    };
  }
  const revision = await readAcceptedOfficialWorkflowRevision(
    db,
    { name: definition.name, revision: definition.revision },
    signal,
  );
  if (!revision) {
    throw new Error("Accepted Official Workflow revision is missing");
  }
  const userTimezone = await loadUserTimezone(db, {
    orgId: args.orgId,
    userId: args.member.userId,
  });
  signal.throwIfAborted();
  const resolved = resolveAllBlueprints(
    revision.definition.blueprints,
    args.blueprints,
    userTimezone,
  );
  return resolved.ok
    ? { catalog, definition, resolved }
    : { kind: "bad-request", message: resolved.message };
}

async function insertInstallingWorkflow(
  db: Db,
  args: {
    readonly installation: InstallOfficialWorkflowArgs;
    readonly agentId: string;
    readonly definition: OfficialWorkflowAcceptedDefinition;
    readonly currentTime: Date;
  },
  signal: AbortSignal,
): Promise<
  { readonly kind: "ok"; readonly workflowId: string } | OfficialWorkflowFailure
> {
  const inserted = await settle(
    db
      .insert(workflows)
      .values({
        orgId: args.installation.orgId,
        agentId: args.agentId,
        name: args.definition.name,
        visibility: "private",
        instruction: null,
        ownerUserId: args.installation.member.userId,
        displayName: null,
        description: null,
        officialDefinitionName: args.definition.name,
        officialInstallationState: "installing",
        createdBy: args.installation.member.userId,
        updatedBy: args.installation.member.userId,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .returning({ id: workflows.id }),
    signal,
  );
  if (!inserted.ok) {
    if (isUniqueViolation(inserted.error)) {
      return {
        kind: "conflict",
        message: `A private workflow named "${args.definition.name}" already exists on this agent`,
      };
    }
    throw inserted.error;
  }
  const workflow = inserted.value[0];
  if (!workflow) {
    throw new Error("Failed to create Official Workflow installation");
  }
  return { kind: "ok", workflowId: workflow.id };
}

function automationFailure(
  automation: Exclude<AutomationResult, { readonly kind: "ok" }>,
): OfficialWorkflowFailure {
  return {
    kind:
      automation.kind === "forbidden"
        ? "forbidden"
        : automation.kind === "not-found"
          ? "not-found"
          : automation.kind === "conflict"
            ? "conflict"
            : "bad-request",
    message:
      "message" in automation
        ? automation.message
        : "Official Workflow automation could not be created",
  };
}

async function completeInstallation(
  args: {
    readonly db: Db;
    readonly installation: InstallOfficialWorkflowArgs;
    readonly resolved: ResolvedInstallation;
    readonly workflowId: string;
    readonly createAutomation: (
      input: CreateAutomationInput,
    ) => Promise<AutomationResult>;
    readonly cleanup: () => Promise<void>;
  },
  signal: AbortSignal,
): Promise<OfficialWorkflowInstallResult> {
  for (const resolvedBlueprint of args.resolved.resolved.blueprints) {
    const input: CreateAutomationInput = {
      ...resolvedBlueprint.createRequest,
      orgId: args.installation.orgId,
      member: args.installation.member,
      workflowId: args.workflowId,
      enabled: true,
      ...(resolvedBlueprint.autonomyBudget === undefined
        ? {}
        : { autonomyBudget: resolvedBlueprint.autonomyBudget }),
      officialInstallation: {
        definitionName: args.resolved.definition.name,
        blueprintKey: resolvedBlueprint.blueprint.key,
        appliedFingerprint: resolvedBlueprint.blueprint.fingerprint,
        parameterBindings: resolvedBlueprint.bindings,
      },
    };
    const automation = await args.createAutomation(input);
    signal.throwIfAborted();
    if (automation.kind !== "ok") {
      await args.cleanup();
      return automationFailure(automation);
    }
  }
  const activation = await args.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
    );
    signal.throwIfAborted();
    const currentCatalog = await readAcceptedOfficialWorkflowCatalog(
      tx,
      signal,
    );
    if (
      !sameAcceptedDefinition(
        args.resolved.catalog.releaseId,
        args.resolved.definition,
        currentCatalog,
      )
    ) {
      return "stale" as const;
    }
    const [installed] = await tx
      .update(workflows)
      .set({ officialInstallationState: "installed", updatedAt: nowDate() })
      .where(
        and(
          eq(workflows.id, args.workflowId),
          eq(workflows.officialInstallationState, "installing"),
        ),
      )
      .returning({ id: workflows.id });
    signal.throwIfAborted();
    return installed ? ("installed" as const) : ("lost" as const);
  });
  signal.throwIfAborted();
  if (activation === "stale") {
    await args.cleanup();
    return {
      kind: "conflict",
      message: "Official Workflow changed during installation; retry",
    };
  }
  if (activation === "lost") {
    await args.cleanup();
    return {
      kind: "conflict",
      message: "Official Workflow installation lost ownership; retry",
    };
  }
  return { kind: "ok", workflowId: args.workflowId };
}

export const installOfficialWorkflow$ = command(
  async (
    { set },
    args: InstallOfficialWorkflowArgs,
    publicBrand: PublicBrand,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowInstallResult> => {
    const db = set(writeDb$);
    const cleanup = async (workflowId: string): Promise<boolean> => {
      const cleanupSignal = new AbortController().signal;
      return await set(
        deleteWorkflow$,
        {
          orgId: args.orgId,
          workflowId,
          allowOfficialInstallationDeletion: true,
          requiredOfficialInstallationState: "installing",
        },
        cleanupSignal,
      );
    };
    const agent = await loadConfigurableAgent(db, args);
    signal.throwIfAborted();
    if (isFailure(agent)) {
      return agent;
    }
    const resolved = await resolveInstallation(db, args, signal);
    if ("kind" in resolved) {
      return resolved;
    }
    const currentTime = nowDate();
    const existing = await recoverOrRejectExistingInstallation(db, cleanup, {
      orgId: args.orgId,
      agentId: agent.id,
      userId: args.member.userId,
      definitionName: args.definitionName,
      currentTime,
    });
    signal.throwIfAborted();
    if (existing) {
      return existing;
    }
    const inserted = await insertInstallingWorkflow(
      db,
      {
        installation: args,
        agentId: agent.id,
        definition: resolved.definition,
        currentTime,
      },
      signal,
    );
    if (inserted.kind !== "ok") {
      return inserted;
    }
    const removeInserted = async (): Promise<void> => {
      await cleanup(inserted.workflowId);
    };
    return await onRejection(
      completeInstallation(
        {
          db,
          installation: args,
          resolved,
          workflowId: inserted.workflowId,
          createAutomation: async (input) => {
            return await set(
              createWorkflowAutomation$,
              input,
              publicBrand,
              signal,
            );
          },
          cleanup: removeInserted,
        },
        signal,
      ),
      removeInserted,
    );
  },
);

async function loadOfficialAutomationRows(db: ReadonlyDb, workflowId: string) {
  return await db
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.workflowId, workflowId))
    .orderBy(asc(workflowAutomations.officialBlueprintKey));
}

type OfficialAutomationRow = Awaited<
  ReturnType<typeof loadOfficialAutomationRows>
>[number];

interface OfficialAutomationPatch {
  readonly kind: "schedule" | "event";
  readonly eventType: OfficialAutomationRow["eventType"];
  readonly eventConfig: OfficialAutomationRow["eventConfig"];
  readonly scheduleType: OfficialAutomationRow["scheduleType"];
  readonly cronExpression: string | null;
  readonly intervalSeconds: number | null;
  readonly atTime: Date | null;
  readonly timezone: string;
  readonly nextRunAt: Date | null;
  readonly autonomyBudget: number;
  readonly officialAppliedFingerprint: string;
  readonly officialParameterBindings: OfficialWorkflowParameterBinding[];
  readonly officialReconciliationStatus: "reconciling";
  readonly updatedAt: Date;
}

type OfficialAutomationPatchResult =
  | { readonly ok: true; readonly patch: OfficialAutomationPatch }
  | { readonly ok: false; readonly message: string };

function blueprintStructureChanged(
  resolved: ResolvedBlueprint,
): OfficialAutomationPatchResult {
  return {
    ok: false,
    message: `Blueprint structure changed: ${resolved.blueprint.key}`,
  };
}

function officialPatchMetadata(resolved: ResolvedBlueprint, currentTime: Date) {
  return {
    autonomyBudget: resolved.autonomyBudget ?? 10,
    officialAppliedFingerprint: resolved.blueprint.fingerprint,
    officialParameterBindings: [...resolved.bindings],
    officialReconciliationStatus: "reconciling" as const,
    updatedAt: currentTime,
  };
}

function eventAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  preparation: OfficialAutomationEventPreparation | undefined,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const request = resolved.createRequest;
  if (
    "schedule" in request ||
    automation.kind !== "event" ||
    automation.eventType !== request.eventType
  ) {
    return blueprintStructureChanged(resolved);
  }
  if (!preparation) {
    throw new Error("Official Workflow event preparation disappeared");
  }
  return {
    ok: true,
    patch: {
      kind: "event",
      eventType: request.eventType,
      eventConfig: preparation.eventConfig,
      scheduleType: null,
      cronExpression: null,
      intervalSeconds: null,
      atTime: null,
      timezone: "UTC",
      nextRunAt: null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

function cronAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  schedule: Extract<WorkflowSchedule, { readonly type: "cron" }>,
  currentTime: Date,
): OfficialAutomationPatchResult {
  if (!isValidTimeZone(schedule.timezone)) {
    return {
      ok: false,
      message: `Invalid timezone for Blueprint: ${resolved.blueprint.key}`,
    };
  }
  const calculated = safeSync(() => {
    return calculateNextRun(
      schedule.cronExpression,
      schedule.timezone,
      currentTime,
    );
  });
  if ("error" in calculated || calculated.ok === null) {
    return {
      ok: false,
      message: `Invalid cron expression for Blueprint: ${resolved.blueprint.key}`,
    };
  }
  return {
    ok: true,
    patch: {
      kind: "schedule",
      eventType: null,
      eventConfig: null,
      scheduleType: "cron",
      cronExpression: schedule.cronExpression,
      intervalSeconds: null,
      atTime: null,
      timezone: schedule.timezone,
      nextRunAt: automation.enabled ? calculated.ok : null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

function onceAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  schedule: Extract<WorkflowSchedule, { readonly type: "once" }>,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const parsed = parseScheduledAtTime(schedule.atTime, schedule.timezone);
  if (
    !parsed.ok ||
    parsed.date.getTime() <= currentTime.getTime() ||
    !isValidTimeZone(schedule.timezone)
  ) {
    return {
      ok: false,
      message: `Invalid one-time schedule for Blueprint: ${resolved.blueprint.key}`,
    };
  }
  return {
    ok: true,
    patch: {
      kind: "schedule",
      eventType: null,
      eventConfig: null,
      scheduleType: "once",
      cronExpression: null,
      intervalSeconds: null,
      atTime: parsed.date,
      timezone: schedule.timezone,
      nextRunAt: automation.enabled ? parsed.date : null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

function loopAutomationPatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  schedule: Extract<WorkflowSchedule, { readonly type: "loop" }>,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const nextFromLastRun = automation.lastRunAt
    ? new Date(automation.lastRunAt.getTime() + schedule.intervalSeconds * 1000)
    : currentTime;
  const nextRunAt =
    nextFromLastRun.getTime() > currentTime.getTime()
      ? nextFromLastRun
      : currentTime;
  return {
    ok: true,
    patch: {
      kind: "schedule",
      eventType: null,
      eventConfig: null,
      scheduleType: "loop",
      cronExpression: null,
      intervalSeconds: schedule.intervalSeconds,
      atTime: null,
      timezone: "UTC",
      nextRunAt: automation.enabled ? nextRunAt : null,
      ...officialPatchMetadata(resolved, currentTime),
    },
  };
}

function schedulePatch(
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
  preparation: OfficialAutomationEventPreparation | undefined,
  currentTime: Date,
): OfficialAutomationPatchResult {
  const request = resolved.createRequest;
  if (!("schedule" in request)) {
    return eventAutomationPatch(automation, resolved, preparation, currentTime);
  }
  if (
    automation.kind !== "schedule" ||
    automation.scheduleType !== request.schedule.type
  ) {
    return blueprintStructureChanged(resolved);
  }
  if (request.schedule.type === "cron") {
    return cronAutomationPatch(
      automation,
      resolved,
      request.schedule,
      currentTime,
    );
  }
  if (request.schedule.type === "once") {
    return onceAutomationPatch(
      automation,
      resolved,
      request.schedule,
      currentTime,
    );
  }
  return loopAutomationPatch(
    automation,
    resolved,
    request.schedule,
    currentTime,
  );
}

function existingBindingsInput(
  automation: OfficialAutomationRow,
  overrides: OfficialWorkflowBlueprintBindings | undefined,
): OfficialWorkflowBlueprintBindings | null {
  if (
    automation.officialBlueprintKey === null ||
    automation.officialParameterBindings === null
  ) {
    return null;
  }
  const merged = new Map(
    automation.officialParameterBindings.map((binding) => {
      return [binding.key, binding.value] as const;
    }),
  );
  for (const binding of overrides?.bindings ?? []) {
    merged.set(binding.key, binding.value);
  }
  return {
    blueprintKey: automation.officialBlueprintKey,
    bindings: [...merged].map(([key, value]) => {
      return { key, value };
    }),
  };
}

function automationRestorePatch(
  row: OfficialAutomationRow,
  nextRunAt: Date | null,
  currentTime: Date,
) {
  return {
    kind: row.kind,
    eventType: row.eventType,
    eventConfig: row.eventConfig,
    scheduleType: row.scheduleType,
    cronExpression: row.cronExpression,
    intervalSeconds: row.intervalSeconds,
    atTime: row.atTime,
    timezone: row.timezone,
    nextRunAt,
    autonomyBudget: row.autonomyBudget,
    officialBlueprintKey: row.officialBlueprintKey,
    officialAppliedFingerprint: row.officialAppliedFingerprint,
    officialReconciliationStatus: row.officialReconciliationStatus,
    officialParameterBindings: row.officialParameterBindings,
    updatedAt: currentTime,
  };
}

function sameOfficialParameterBindings(
  left: OfficialAutomationRow["officialParameterBindings"],
  right: OfficialAutomationRow["officialParameterBindings"],
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.length === right.length &&
    left.every((binding, index) => {
      const compared = right[index];
      return (
        compared !== undefined &&
        binding.key === compared.key &&
        binding.value === compared.value
      );
    })
  );
}

function sameReconfigurationBaseline(
  expected: OfficialAutomationRow,
  current: OfficialAutomationRow,
): boolean {
  return (
    expected.id === current.id &&
    expected.officialBlueprintKey === current.officialBlueprintKey &&
    expected.officialAppliedFingerprint ===
      current.officialAppliedFingerprint &&
    sameOfficialParameterBindings(
      expected.officialParameterBindings,
      current.officialParameterBindings,
    )
  );
}

function sameOptionalDate(left: Date | null, right: Date | null): boolean {
  return left === null || right === null
    ? left === right
    : left.getTime() === right.getTime();
}

function sameOperationalState(
  expected: OfficialAutomationRow,
  current: OfficialAutomationRow,
): boolean {
  return (
    expected.enabled === current.enabled &&
    sameOptionalDate(expected.nextRunAt, current.nextRunAt) &&
    sameOptionalDate(expected.lastRunAt, current.lastRunAt) &&
    expected.lastRunId === current.lastRunId &&
    expected.consecutiveFailures === current.consecutiveFailures &&
    expected.officialIntendedEnabled === current.officialIntendedEnabled
  );
}

function refreshOfficialAutomationPatch(
  automation: OfficialAutomationRow,
  patch: OfficialAutomationPatch,
  currentTime: Date,
): OfficialAutomationPatch {
  let nextRunAt: Date | null = null;
  if (automation.enabled && patch.kind === "schedule") {
    if (patch.scheduleType === "cron") {
      if (!patch.cronExpression) {
        throw new Error("Official cron schedule is incomplete");
      }
      nextRunAt = calculateNextRun(
        patch.cronExpression,
        patch.timezone,
        currentTime,
      );
      if (!nextRunAt) {
        throw new Error("Official cron schedule has no next run");
      }
    } else if (patch.scheduleType === "once") {
      if (!patch.atTime) {
        throw new Error("Official one-time schedule is incomplete");
      }
      nextRunAt = patch.atTime;
    } else if (patch.scheduleType === "loop") {
      if (patch.intervalSeconds === null) {
        throw new Error("Official loop schedule is incomplete");
      }
      const nextFromLastRun = automation.lastRunAt
        ? new Date(
            automation.lastRunAt.getTime() + patch.intervalSeconds * 1000,
          )
        : currentTime;
      nextRunAt =
        nextFromLastRun.getTime() > currentTime.getTime()
          ? nextFromLastRun
          : currentTime;
    }
  }
  return { ...patch, nextRunAt, updatedAt: currentTime };
}

interface ReconfigureOfficialWorkflowArgs {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly workflowId: string;
  readonly blueprints: readonly OfficialWorkflowBlueprintBindings[];
}

interface ReconfigurationContext {
  readonly workflowId: string;
  readonly catalog: NonNullable<
    Awaited<ReturnType<typeof readAcceptedOfficialWorkflowCatalog>>
  >;
  readonly definition: OfficialWorkflowAcceptedDefinition;
  readonly blueprints: readonly OfficialWorkflowAcceptedBlueprint[];
  readonly automations: readonly OfficialAutomationRow[];
  readonly automationByKey: ReadonlyMap<string, OfficialAutomationRow>;
  readonly blueprintKeys: ReadonlySet<string>;
}

type ReconfigurationContextResult =
  | { readonly ok: true; readonly context: ReconfigurationContext }
  | { readonly ok: false; readonly failure: OfficialWorkflowFailure };

type MergedBindingsResult =
  | {
      readonly ok: true;
      readonly bindings: readonly OfficialWorkflowBlueprintBindings[];
    }
  | { readonly ok: false; readonly failure: OfficialWorkflowFailure };

type ReconfigurationPatchesResult =
  | {
      readonly ok: true;
      readonly patches: ReadonlyMap<string, OfficialAutomationPatch>;
      readonly preparations: ReadonlyMap<
        string,
        OfficialAutomationEventPreparation
      >;
    }
  | { readonly ok: false; readonly failure: OfficialWorkflowFailure };

type PrepareReconfigurationEvent = (
  automation: OfficialAutomationRow,
  resolved: ResolvedBlueprint,
) => Promise<OfficialAutomationEventPreparationResult>;

function eventPreparationFailure(
  result: Exclude<
    OfficialAutomationEventPreparationResult,
    { readonly kind: "ok" }
  >,
): OfficialWorkflowFailure {
  if (result.kind === "not-found") {
    return {
      kind: "not-found",
      message: "Official Workflow automation not found",
    };
  }
  if (result.kind === "forbidden") {
    return { kind: "forbidden", message: result.message };
  }
  if (result.kind === "conflict") {
    return { kind: "conflict", message: result.message };
  }
  return { kind: "bad-request", message: result.message };
}

async function markNeedsReconfiguration(
  db: Db,
  workflowId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .update(workflowAutomations)
    .set({
      officialReconciliationStatus: "needs_reconfiguration",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(workflowAutomations.workflowId, workflowId),
        isNotNull(workflowAutomations.officialBlueprintKey),
        ne(workflowAutomations.officialReconciliationStatus, "reconciling"),
      ),
    );
  signal.throwIfAborted();
}

function indexOfficialAutomations(
  automations: readonly OfficialAutomationRow[],
  blueprints: readonly OfficialWorkflowAcceptedBlueprint[],
):
  | {
      readonly automationByKey: ReadonlyMap<string, OfficialAutomationRow>;
      readonly blueprintKeys: ReadonlySet<string>;
    }
  | undefined {
  const automationByKey = new Map(
    automations.flatMap((automation) => {
      return automation.officialBlueprintKey
        ? [[automation.officialBlueprintKey, automation] as const]
        : [];
    }),
  );
  const blueprintKeys = new Set(
    blueprints.map((blueprint) => {
      return blueprint.key;
    }),
  );
  const hasUnexpectedKey = [...automationByKey.keys()].some((key) => {
    return !blueprintKeys.has(key);
  });
  if (
    automationByKey.size !== blueprints.length ||
    automations.length !== automationByKey.size ||
    hasUnexpectedKey
  ) {
    return undefined;
  }
  return { automationByKey, blueprintKeys };
}

async function loadReconfigurationContext(
  db: Db,
  args: ReconfigureOfficialWorkflowArgs,
  signal: AbortSignal,
): Promise<ReconfigurationContextResult> {
  const [workflow] = await db
    .select({
      id: workflows.id,
      definitionName: workflows.officialDefinitionName,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.id, args.workflowId),
        eq(workflows.ownerUserId, args.member.userId),
        eq(workflows.officialInstallationState, "installed"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!workflow?.definitionName) {
    return {
      ok: false,
      failure: {
        kind: "not-found",
        message: `Official Workflow installation not found: ${args.workflowId}`,
      },
    };
  }
  const catalog = await readAcceptedOfficialWorkflowCatalog(db, signal);
  const definition = catalog?.payload.definitions.find((entry) => {
    return entry.name === workflow.definitionName;
  });
  if (!catalog || !definition) {
    return {
      ok: false,
      failure: {
        kind: "conflict",
        message: "Accepted Official Workflow definition is unavailable",
      },
    };
  }
  const revision = await readAcceptedOfficialWorkflowRevision(
    db,
    { name: definition.name, revision: definition.revision },
    signal,
  );
  if (!revision) {
    return {
      ok: false,
      failure: {
        kind: "conflict",
        message: "Accepted Official Workflow revision is unavailable",
      },
    };
  }
  const automations = await loadOfficialAutomationRows(db, workflow.id);
  signal.throwIfAborted();
  const indexed = indexOfficialAutomations(
    automations,
    revision.definition.blueprints,
  );
  if (!indexed) {
    await markNeedsReconfiguration(db, workflow.id, signal);
    return {
      ok: false,
      failure: {
        kind: "conflict",
        message: "Official Workflow Blueprint structure changed",
      },
    };
  }
  return {
    ok: true,
    context: {
      workflowId: workflow.id,
      catalog,
      definition,
      blueprints: revision.definition.blueprints,
      automations,
      ...indexed,
    },
  };
}

function duplicateBindingKey(
  bindings: readonly OfficialWorkflowParameterBinding[],
): string | undefined {
  const keys = new Set<string>();
  for (const binding of bindings) {
    if (keys.has(binding.key)) {
      return binding.key;
    }
    keys.add(binding.key);
  }
  return undefined;
}

function mergeReconfigurationBindings(
  context: ReconfigurationContext,
  overrides: readonly OfficialWorkflowBlueprintBindings[],
): MergedBindingsResult {
  const overridesByKey = new Map<string, OfficialWorkflowBlueprintBindings>();
  for (const entry of overrides) {
    if (overridesByKey.has(entry.blueprintKey)) {
      return {
        ok: false,
        failure: {
          kind: "bad-request",
          message: `Duplicate Blueprint bindings: ${entry.blueprintKey}`,
        },
      };
    }
    if (!context.blueprintKeys.has(entry.blueprintKey)) {
      return {
        ok: false,
        failure: {
          kind: "bad-request",
          message: `Unknown Blueprint: ${entry.blueprintKey}`,
        },
      };
    }
    const duplicate = duplicateBindingKey(entry.bindings);
    if (duplicate) {
      return {
        ok: false,
        failure: {
          kind: "bad-request",
          message: `Duplicate parameter binding: ${entry.blueprintKey}.${duplicate}`,
        },
      };
    }
    overridesByKey.set(entry.blueprintKey, entry);
  }
  const bindings: OfficialWorkflowBlueprintBindings[] = [];
  for (const blueprint of context.blueprints) {
    const automation = context.automationByKey.get(blueprint.key);
    if (!automation) {
      throw new Error("Official Workflow automation disappeared");
    }
    const merged = existingBindingsInput(
      automation,
      overridesByKey.get(blueprint.key),
    );
    if (!merged) {
      return {
        ok: false,
        failure: {
          kind: "conflict",
          message: `Official Workflow binding state is incomplete: ${blueprint.key}`,
        },
      };
    }
    bindings.push(merged);
  }
  return { ok: true, bindings };
}

async function buildReconfigurationPatches(
  db: Db,
  args: {
    readonly context: ReconfigurationContext;
    readonly resolved: Extract<ResolveResult, { readonly ok: true }>;
    readonly currentTime: Date;
    readonly prepareEvent: PrepareReconfigurationEvent;
  },
  signal: AbortSignal,
): Promise<ReconfigurationPatchesResult> {
  const patches = new Map<string, OfficialAutomationPatch>();
  const preparations = new Map<string, OfficialAutomationEventPreparation>();
  for (const resolvedBlueprint of args.resolved.blueprints) {
    const automation = args.context.automationByKey.get(
      resolvedBlueprint.blueprint.key,
    );
    if (!automation) {
      throw new Error("Official Workflow automation disappeared");
    }
    let preparation: OfficialAutomationEventPreparation | undefined;
    if (!("schedule" in resolvedBlueprint.createRequest)) {
      const prepared = await args.prepareEvent(automation, resolvedBlueprint);
      signal.throwIfAborted();
      if (prepared.kind !== "ok") {
        return { ok: false, failure: eventPreparationFailure(prepared) };
      }
      preparation = prepared.preparation;
      preparations.set(automation.id, preparation);
    }
    const patch = schedulePatch(
      automation,
      resolvedBlueprint,
      preparation,
      args.currentTime,
    );
    if (!patch.ok) {
      await markNeedsReconfiguration(db, args.context.workflowId, signal);
      return {
        ok: false,
        failure: { kind: "conflict", message: patch.message },
      };
    }
    patches.set(automation.id, patch.patch);
  }
  return { ok: true, patches, preparations };
}

async function persistReconfiguration(
  db: Db,
  args: {
    readonly context: ReconfigurationContext;
    readonly patches: ReadonlyMap<string, OfficialAutomationPatch>;
    readonly preparations: ReadonlyMap<
      string,
      OfficialAutomationEventPreparation
    >;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly ok: true;
      readonly original: readonly OfficialAutomationRow[];
      readonly updated: readonly OfficialAutomationRow[];
      readonly googleFormsCursorByAutomationId: ReadonlyMap<string, string>;
    }
  | { readonly ok: false }
> {
  const persisted = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${OFFICIAL_WORKFLOW_CATALOG_ACTIVATION_LOCK}))`,
    );
    signal.throwIfAborted();
    const currentCatalog = await readAcceptedOfficialWorkflowCatalog(
      tx,
      signal,
    );
    if (
      !sameAcceptedDefinition(
        args.context.catalog.releaseId,
        args.context.definition,
        currentCatalog,
      )
    ) {
      return { ok: false as const };
    }
    const original = await tx
      .select()
      .from(workflowAutomations)
      .where(eq(workflowAutomations.workflowId, args.context.workflowId))
      .orderBy(asc(workflowAutomations.officialBlueprintKey))
      .for("update");
    signal.throwIfAborted();
    const indexed = indexOfficialAutomations(original, args.context.blueprints);
    if (
      !indexed ||
      original.some((automation) => {
        return automation.officialReconciliationStatus === "reconciling";
      }) ||
      args.context.automations.some((expected) => {
        if (expected.officialBlueprintKey === null) {
          return true;
        }
        const current = indexed.automationByKey.get(
          expected.officialBlueprintKey,
        );
        return !current || !sameReconfigurationBaseline(expected, current);
      })
    ) {
      return { ok: false as const };
    }
    const googleFormsCursors = await tx
      .select({
        automationId: googleFormsAutomationCursors.automationId,
        cursor: googleFormsAutomationCursors.lastSeenSubmittedTime,
      })
      .from(googleFormsAutomationCursors)
      .innerJoin(
        workflowAutomations,
        eq(workflowAutomations.id, googleFormsAutomationCursors.automationId),
      )
      .where(eq(workflowAutomations.workflowId, args.context.workflowId));
    const currentTime = nowDate();
    const rows: OfficialAutomationRow[] = [];
    for (const automation of original) {
      const patch = args.patches.get(automation.id);
      if (!patch) {
        return { ok: false as const };
      }
      const [row] = await tx
        .update(workflowAutomations)
        .set(refreshOfficialAutomationPatch(automation, patch, currentTime))
        .where(eq(workflowAutomations.id, automation.id))
        .returning();
      if (!row) {
        throw new Error("Official Workflow automation disappeared");
      }
      const strapiIntegrationId = args.preparations.get(
        automation.id,
      )?.strapiIntegrationId;
      if (strapiIntegrationId !== undefined) {
        const [binding] = await tx
          .update(strapiWorkflowAutomations)
          .set({ integrationId: strapiIntegrationId })
          .where(eq(strapiWorkflowAutomations.automationId, automation.id))
          .returning({ automationId: strapiWorkflowAutomations.automationId });
        if (!binding) {
          throw new Error("Official Strapi automation binding disappeared");
        }
      }
      rows.push(row);
    }
    signal.throwIfAborted();
    return {
      ok: true as const,
      original,
      updated: rows,
      googleFormsCursorByAutomationId: new Map(
        googleFormsCursors.map((cursor) => {
          return [cursor.automationId, cursor.cursor] as const;
        }),
      ),
    };
  });
  return persisted;
}

function strapiIntegrationIdFromAutomation(
  automation: OfficialAutomationRow,
): string | undefined {
  if (automation.eventType !== "strapi-entry-published") {
    return undefined;
  }
  if (
    !isJsonObject(automation.eventConfig) ||
    typeof automation.eventConfig.integrationId !== "string"
  ) {
    throw new Error("Official Strapi automation binding is invalid");
  }
  return automation.eventConfig.integrationId;
}

async function markReconfigurationFailed(
  db: Db,
  workflowId: string,
): Promise<void> {
  await db
    .update(workflowAutomations)
    .set({
      officialReconciliationStatus: "failed",
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(workflowAutomations.workflowId, workflowId),
        isNotNull(workflowAutomations.officialBlueprintKey),
      ),
    );
}

async function restoreReconfiguration(
  db: Db,
  args: {
    readonly workflowId: string;
    readonly original: readonly OfficialAutomationRow[];
    readonly updated: readonly OfficialAutomationRow[];
    readonly googleFormsCursorByAutomationId: ReadonlyMap<string, string>;
  },
): Promise<void> {
  const updatedById = new Map(
    args.updated.map((automation) => {
      return [automation.id, automation] as const;
    }),
  );
  const currentTime = nowDate();
  await db.transaction(async (tx) => {
    for (const automation of args.original) {
      const expectedUpdated = updatedById.get(automation.id);
      if (!expectedUpdated) {
        throw new Error("Official Workflow rollback state is incomplete");
      }
      const [current] = await tx
        .select()
        .from(workflowAutomations)
        .where(eq(workflowAutomations.id, automation.id))
        .for("update")
        .limit(1);
      if (!current || current.officialReconciliationStatus !== "reconciling") {
        continue;
      }
      const nextRunAt = sameOperationalState(expectedUpdated, current)
        ? automation.nextRunAt
        : current.nextRunAt;
      const [restored] = await tx
        .update(workflowAutomations)
        .set(automationRestorePatch(automation, nextRunAt, currentTime))
        .where(
          and(
            eq(workflowAutomations.id, automation.id),
            eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
          ),
        )
        .returning({ id: workflowAutomations.id });
      if (!restored) {
        continue;
      }
      const strapiIntegrationId = strapiIntegrationIdFromAutomation(automation);
      if (strapiIntegrationId !== undefined) {
        const [binding] = await tx
          .update(strapiWorkflowAutomations)
          .set({ integrationId: strapiIntegrationId })
          .where(eq(strapiWorkflowAutomations.automationId, automation.id))
          .returning({ automationId: strapiWorkflowAutomations.automationId });
        if (!binding) {
          throw new Error("Official Strapi automation binding disappeared");
        }
      }
    }
  });
  const current = await loadOfficialAutomationRows(db, args.workflowId);
  const currentIds = new Set(
    current.map((automation) => {
      return automation.id;
    }),
  );
  const cleanupSignal = new AbortController().signal;
  const restoration = await settle(
    reconcileAutomationEventWatchReconfiguration(
      db,
      {
        previous: args.updated,
        current,
        googleForms: [...args.googleFormsCursorByAutomationId].flatMap(
          ([automationId, seedCursor]) => {
            return currentIds.has(automationId)
              ? [{ automationId, seedCursor }]
              : [];
          },
        ),
      },
      cleanupSignal,
    ),
    cleanupSignal,
  );
  if (!restoration.ok) {
    await markReconfigurationFailed(db, args.workflowId);
    throw restoration.error;
  }
  if (restoration.value.kind !== "ok") {
    await markReconfigurationFailed(db, args.workflowId);
    throw new Error(restoration.value.message);
  }
}

async function finalizeReconfiguration(
  db: Db,
  args: {
    readonly workflowId: string;
    readonly userId: string;
    readonly updated: readonly OfficialAutomationRow[];
  },
  signal: AbortSignal,
): Promise<void> {
  const currentTime = nowDate();
  await db.transaction(async (tx) => {
    for (const automation of args.updated) {
      const [finalized] = await tx
        .update(workflowAutomations)
        .set({
          officialReconciliationStatus: "current",
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(workflowAutomations.id, automation.id),
            eq(workflowAutomations.officialReconciliationStatus, "reconciling"),
          ),
        )
        .returning({ id: workflowAutomations.id });
      if (!finalized) {
        throw new Error("Official Workflow reconciliation lost ownership");
      }
    }
    const [workflow] = await tx
      .update(workflows)
      .set({ updatedBy: args.userId, updatedAt: currentTime })
      .where(eq(workflows.id, args.workflowId))
      .returning({ id: workflows.id });
    if (!workflow) {
      throw new Error("Official Workflow installation disappeared");
    }
  });
  signal.throwIfAborted();
}

async function reconcileReconfiguration(
  db: Db,
  args: {
    readonly workflowId: string;
    readonly userId: string;
    readonly original: readonly OfficialAutomationRow[];
    readonly updated: readonly OfficialAutomationRow[];
    readonly preparations: ReadonlyMap<
      string,
      OfficialAutomationEventPreparation
    >;
    readonly googleFormsCursorByAutomationId: ReadonlyMap<string, string>;
  },
  signal: AbortSignal,
): Promise<OfficialWorkflowFailure | null> {
  const rollback = async (): Promise<void> => {
    await restoreReconfiguration(db, {
      workflowId: args.workflowId,
      original: args.original,
      updated: args.updated,
      googleFormsCursorByAutomationId: args.googleFormsCursorByAutomationId,
    });
  };
  const apply = async (): Promise<OfficialWorkflowFailure | null> => {
    const googleForms = [...args.preparations].flatMap(
      ([automationId, preparation]) => {
        return preparation.googleFormsSeedCursor === undefined
          ? []
          : [
              {
                automationId,
                seedCursor: preparation.googleFormsSeedCursor,
              },
            ];
      },
    );
    const reconciled = await reconcileAutomationEventWatchReconfiguration(
      db,
      {
        previous: args.original,
        current: args.updated,
        googleForms,
      },
      signal,
    );
    signal.throwIfAborted();
    if (reconciled.kind !== "ok") {
      return { kind: "bad-request", message: reconciled.message };
    }
    await finalizeReconfiguration(
      db,
      {
        workflowId: args.workflowId,
        userId: args.userId,
        updated: args.updated,
      },
      signal,
    );
    return null;
  };
  const failure = await onRejection(apply(), rollback);
  if (failure) {
    await rollback();
  }
  return failure;
}

export const reconfigureOfficialWorkflow$ = command(
  async (
    { set },
    args: ReconfigureOfficialWorkflowArgs,
    publicBrand: PublicBrand,
    signal: AbortSignal,
  ): Promise<OfficialWorkflowReconfigureResult> => {
    const db = set(writeDb$);
    const loaded = await loadReconfigurationContext(db, args, signal);
    if (!loaded.ok) {
      return loaded.failure;
    }
    const context = loaded.context;
    const merged = mergeReconfigurationBindings(context, args.blueprints);
    if (!merged.ok) {
      return merged.failure;
    }
    const userTimezone = await loadUserTimezone(db, {
      orgId: args.orgId,
      userId: args.member.userId,
    });
    signal.throwIfAborted();
    const resolved = resolveAllBlueprints(
      context.blueprints,
      merged.bindings,
      userTimezone,
    );
    if (!resolved.ok) {
      return { kind: "bad-request", message: resolved.message };
    }
    const currentTime = nowDate();
    const patched = await buildReconfigurationPatches(
      db,
      {
        context,
        resolved,
        currentTime,
        prepareEvent: async (automation, resolvedBlueprint) => {
          const input: CreateAutomationInput = {
            ...resolvedBlueprint.createRequest,
            orgId: args.orgId,
            member: args.member,
            workflowId: context.workflowId,
            enabled: automation.enabled,
            ...(resolvedBlueprint.autonomyBudget === undefined
              ? {}
              : { autonomyBudget: resolvedBlueprint.autonomyBudget }),
          };
          return await set(
            prepareOfficialAutomationReconfiguration$,
            { automationId: automation.id, input, publicBrand },
            signal,
          );
        },
      },
      signal,
    );
    if (!patched.ok) {
      return patched.failure;
    }
    const persisted = await persistReconfiguration(
      db,
      {
        context,
        patches: patched.patches,
        preparations: patched.preparations,
      },
      signal,
    );
    if (!persisted.ok) {
      return {
        kind: "conflict",
        message: "Official Workflow changed during reconfiguration; retry",
      };
    }
    const reconciliationFailure = await reconcileReconfiguration(
      db,
      {
        workflowId: context.workflowId,
        userId: args.member.userId,
        original: persisted.original,
        updated: persisted.updated,
        preparations: patched.preparations,
        googleFormsCursorByAutomationId:
          persisted.googleFormsCursorByAutomationId,
      },
      signal,
    );
    if (reconciliationFailure) {
      return reconciliationFailure;
    }
    return { kind: "ok", workflowId: context.workflowId };
  },
);
