import { command, computed, type Getter, type Setter } from "ccstate";
import { and, asc, eq } from "drizzle-orm";

import {
  githubLabelAppliedEventConfigSchema,
  type GithubLabelAppliedEventConfig,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import {
  workflowUserTriggerThreads,
  zeroWorkflowGithubProcessedEvents,
  zeroWorkflowTriggers,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import {
  buildChatOnlyWorkflowTriggerCallbacks,
  runWorkflowTriggerNow$,
  type TriggerRow,
} from "./zero-workflow-trigger-run.service";
import { ensureWorkflowUserTriggerThread } from "./zero-workflow-user-trigger-thread.service";

const log = logger("api:github-workflow-event");

type GithubInstallationRecord = typeof githubInstallations.$inferSelect;
type GithubWorkflowSubjectKind = "issue" | "pull_request";

interface GithubUser {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

interface GithubLabel {
  readonly name: string;
}

interface GithubIssueLike {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly GithubLabel[];
  readonly user: GithubUser;
}

interface GithubRepository {
  readonly full_name: string;
}

interface GithubInstallationRef {
  readonly id: number;
}

interface GithubLabelWorkflowEventPayload {
  readonly action: string;
  readonly issue: GithubIssueLike;
  readonly label: GithubLabel | undefined;
  readonly repository: GithubRepository;
  readonly installation: GithubInstallationRef;
  readonly sender: GithubUser;
}

interface GithubLabelEventTriggerRow {
  readonly trigger: TriggerRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GithubLabelAppliedEventConfig;
}

type GithubWorkflowRunStarter = (args: {
  readonly trigger: GithubLabelEventTriggerRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly matchedLabelName: string;
}) => Promise<"ok" | "error">;

interface GithubWorkflowDispatchCounts {
  readonly dispatched: number;
  readonly duplicates: number;
}

export interface GithubWorkflowRunStartTestInput {
  readonly triggerId: string;
  readonly workflowName: string;
  readonly deliveryId: string;
  readonly repo: string;
  readonly subjectType: GithubWorkflowSubjectKind;
  readonly subjectNumber: number;
  readonly action: string;
  readonly labelName: string;
  readonly actorLogin: string;
}

const githubWorkflowRunStarterOverride = testOverride<
  | ((args: GithubWorkflowRunStartTestInput) => Promise<"ok" | "error">)
  | undefined
>(() => {
  return undefined;
});

export function setGithubWorkflowRunStarterForTests(
  starter: (args: GithubWorkflowRunStartTestInput) => Promise<"ok" | "error">,
): () => void {
  githubWorkflowRunStarterOverride.set(starter);
  return () => {
    githubWorkflowRunStarterOverride.clear();
  };
}

export function normalizeGithubWorkflowLabelName(labelName: string): string {
  return labelName.trim().toLowerCase();
}

export function workflowGithubLabelEventTriggersEnabledForOwner(
  orgId: string,
  userId: string,
) {
  return computed(async (get) => {
    const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
    return isFeatureEnabled(FeatureSwitchKey.WorkflowGithubLabelEventTriggers, {
      orgId,
      userId,
      overrides,
    });
  });
}

export async function loadOrgGithubWorkflowInstallation(
  db: ReadonlyDb,
  orgId: string,
): Promise<GithubInstallationRecord | null> {
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  return installation ?? null;
}

async function loadGithubUserLink(args: {
  readonly db: ReadonlyDb;
  readonly installationId: string;
  readonly userId: string;
}): Promise<{ readonly githubUserId: string } | null> {
  const [link] = await args.db
    .select({ githubUserId: githubUserLinks.githubUserId })
    .from(githubUserLinks)
    .where(
      and(
        eq(githubUserLinks.installationId, args.installationId),
        eq(githubUserLinks.vm0UserId, args.userId),
      ),
    )
    .limit(1);
  return link ?? null;
}

export async function prepareGithubLabelEventConfigForPersist(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly eventConfig: GithubLabelAppliedEventConfig;
  },
): Promise<
  | { readonly kind: "ok"; readonly eventConfig: GithubLabelAppliedEventConfig }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const installation = await loadOrgGithubWorkflowInstallation(db, args.orgId);
  if (!installation) {
    return {
      kind: "bad-request",
      message: "Install GitHub before creating GitHub label workflow triggers",
    };
  }

  if (args.eventConfig.filters.actor.type === "me") {
    const link = await loadGithubUserLink({
      db,
      installationId: installation.id,
      userId: args.userId,
    });
    if (!link) {
      return {
        kind: "bad-request",
        message:
          "Connect your GitHub account before using Triggered by me for GitHub label workflow triggers",
      };
    }
  }

  return {
    kind: "ok",
    eventConfig: githubLabelAppliedEventConfigSchema.parse(args.eventConfig),
  };
}

async function findActiveInstallation(args: {
  readonly db: ReadonlyDb;
  readonly ghInstallationId: string;
}): Promise<GithubInstallationRecord | null> {
  const [installation] = await args.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, args.ghInstallationId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  return installation ?? null;
}

function labelsForAction(args: {
  readonly action: string;
  readonly labels: readonly GithubLabel[];
  readonly label: GithubLabel | undefined;
}): readonly string[] {
  if (args.action === "labeled") {
    return args.label ? [args.label.name] : [];
  }
  if (args.action === "opened") {
    return args.labels.map((label) => {
      return label.name;
    });
  }
  return [];
}

function matchingLabelName(args: {
  readonly labelNames: readonly string[];
  readonly config: GithubLabelAppliedEventConfig;
}): string | null {
  const expected = normalizeGithubWorkflowLabelName(args.config.labelName);
  return (
    args.labelNames.find((labelName) => {
      return normalizeGithubWorkflowLabelName(labelName) === expected;
    }) ?? null
  );
}

function subjectMatchesConfig(args: {
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly config: GithubLabelAppliedEventConfig;
}): boolean {
  const subject = args.config.filters.subject;
  return (
    subject === "both" ||
    (subject === "issues" && args.subjectKind === "issue") ||
    (subject === "pull_requests" && args.subjectKind === "pull_request")
  );
}

async function actorMatchesConfig(args: {
  readonly db: ReadonlyDb;
  readonly installation: GithubInstallationRecord;
  readonly trigger: GithubLabelEventTriggerRow;
  readonly sender: GithubUser;
}): Promise<boolean> {
  if (args.trigger.config.filters.actor.type === "anyone") {
    return true;
  }
  const link = await loadGithubUserLink({
    db: args.db,
    installationId: args.installation.id,
    userId: args.trigger.trigger.ownerUserId,
  });
  return link?.githubUserId === String(args.sender.id);
}

async function loadGithubLabelEventTriggers(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<readonly GithubLabelEventTriggerRow[]> {
  const triggerRows = await args.db
    .select({
      trigger: zeroWorkflowTriggers,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
      chatThreadId: workflowUserTriggerThreads.chatThreadId,
    })
    .from(zeroWorkflowTriggers)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowTriggers.workflowId, zeroWorkflows.id),
    )
    .leftJoin(
      workflowUserTriggerThreads,
      and(
        eq(workflowUserTriggerThreads.orgId, zeroWorkflowTriggers.orgId),
        eq(workflowUserTriggerThreads.userId, zeroWorkflowTriggers.ownerUserId),
        eq(
          workflowUserTriggerThreads.workflowId,
          zeroWorkflowTriggers.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowTriggers.orgId, args.orgId),
        eq(zeroWorkflowTriggers.enabled, true),
        eq(zeroWorkflowTriggers.kind, "event"),
        eq(zeroWorkflowTriggers.eventType, "github-label-applied"),
      ),
    )
    .orderBy(asc(zeroWorkflowTriggers.createdAt));
  args.signal.throwIfAborted();

  const currentTime = nowDate();
  const triggers: GithubLabelEventTriggerRow[] = [];
  for (const row of triggerRows) {
    const config = githubLabelAppliedEventConfigSchema.safeParse(
      row.trigger.eventConfig,
    );
    if (!config.success) {
      continue;
    }
    const chatThreadId =
      row.chatThreadId ??
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserTriggerThread(tx, {
          orgId: row.trigger.orgId,
          userId: row.trigger.ownerUserId,
          workflowId: row.trigger.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    args.signal.throwIfAborted();
    triggers.push({
      trigger: row.trigger,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
      config: config.data,
    });
  }
  return triggers;
}

async function insertGithubProcessedEvent(args: {
  readonly db: Db;
  readonly trigger: GithubLabelEventTriggerRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
}): Promise<string | null> {
  const [processed] = await args.db
    .insert(zeroWorkflowGithubProcessedEvents)
    .values({
      triggerId: args.trigger.trigger.id,
      githubDeliveryId: args.deliveryId,
      repo: args.payload.repository.full_name,
      subjectType: args.subjectKind,
      subjectNumber: args.payload.issue.number,
      action: args.payload.action,
      labelNameNormalized: normalizeGithubWorkflowLabelName(
        args.trigger.config.labelName,
      ),
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: zeroWorkflowGithubProcessedEvents.id });
  return processed?.id ?? null;
}

function githubSubjectUrl(args: {
  readonly repo: string;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly subjectNumber: number;
}): string {
  const pathSegment = args.subjectKind === "pull_request" ? "pull" : "issues";
  return `https://github.com/${args.repo}/${pathSegment}/${args.subjectNumber}`;
}

function buildGithubWorkflowEventSystemPrompt(args: {
  readonly trigger: GithubLabelEventTriggerRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly matchedLabelName: string;
}): string {
  const subjectLabel =
    args.subjectKind === "pull_request" ? "pull request" : "issue";
  return [
    "# Current context",
    `You are running because the GitHub label "${args.matchedLabelName}" was applied to a ${subjectLabel}.`,
    "The workflow's procedure is available as a skill - execute it now.",
    "This run is linked to a web chat thread; everything you output is shown to the user there.",
    "This context intentionally includes only event metadata. It does not include the issue or pull request body, comments, files, or diffs.",
    "Use connected GitHub tools or the GitHub API to inspect the issue or pull request if the workflow needs more detail.",
    "",
    "# GitHub event",
    JSON.stringify(
      {
        triggerId: args.trigger.trigger.id,
        deliveryId: args.deliveryId,
        event: "label_applied",
        action: args.payload.action,
        repository: args.payload.repository.full_name,
        labelName: args.matchedLabelName,
        subject: {
          type: args.subjectKind,
          number: args.payload.issue.number,
          title: args.payload.issue.title,
          url: githubSubjectUrl({
            repo: args.payload.repository.full_name,
            subjectKind: args.subjectKind,
            subjectNumber: args.payload.issue.number,
          }),
        },
        actor: {
          id: String(args.payload.sender.id),
          login: args.payload.sender.login,
          type: args.payload.sender.type,
        },
        currentLabels: args.payload.issue.labels.map((label) => {
          return label.name;
        }),
      },
      null,
      2,
    ),
  ].join("\n");
}

async function dispatchGithubTriggerEvent(args: {
  readonly db: Db;
  readonly trigger: GithubLabelEventTriggerRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly matchedLabelName: string;
  readonly startRun: GithubWorkflowRunStarter;
}): Promise<"dispatched" | "duplicate" | { readonly kind: "run_error" }> {
  const processedId = await insertGithubProcessedEvent(args);
  if (!processedId) {
    return "duplicate";
  }

  const result = await args.startRun({
    trigger: args.trigger,
    deliveryId: args.deliveryId,
    payload: args.payload,
    subjectKind: args.subjectKind,
    matchedLabelName: args.matchedLabelName,
  });
  if (result !== "ok") {
    await args.db
      .delete(zeroWorkflowGithubProcessedEvents)
      .where(eq(zeroWorkflowGithubProcessedEvents.id, processedId));
    return { kind: "run_error" };
  }

  return "dispatched";
}

function createGithubWorkflowRunStarter(args: {
  readonly set: Setter;
  readonly apiStartTime: number;
  readonly signal: AbortSignal;
}): GithubWorkflowRunStarter {
  const runStarterOverride = githubWorkflowRunStarterOverride.get();
  if (runStarterOverride) {
    return async ({
      trigger,
      deliveryId,
      payload,
      subjectKind,
      matchedLabelName,
    }) => {
      return await runStarterOverride({
        triggerId: trigger.trigger.id,
        workflowName: trigger.workflowName,
        deliveryId,
        repo: payload.repository.full_name,
        subjectType: subjectKind,
        subjectNumber: payload.issue.number,
        action: payload.action,
        labelName: matchedLabelName,
        actorLogin: payload.sender.login,
      });
    };
  }

  return async ({
    trigger,
    deliveryId,
    payload,
    subjectKind,
    matchedLabelName,
  }) => {
    const result = await args.set(
      runWorkflowTriggerNow$,
      {
        due: {
          trigger: trigger.trigger,
          agentId: trigger.agentId,
          workflowName: trigger.workflowName,
          chatThreadId: trigger.chatThreadId,
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "workflow-event",
        appendSystemPrompt: buildGithubWorkflowEventSystemPrompt({
          trigger,
          deliveryId,
          payload,
          subjectKind,
          matchedLabelName,
        }),
        callbacks: buildChatOnlyWorkflowTriggerCallbacks(
          trigger.chatThreadId,
          trigger.agentId,
        ),
        activePreviousRunPolicy: "allow",
        recordLastRunId: false,
        recordLastRunAt: true,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      args.signal,
    );
    args.signal.throwIfAborted();
    return result.kind === "ok" ? "ok" : "error";
  };
}

async function matchedLabelForTrigger(args: {
  readonly get: Getter;
  readonly db: Db;
  readonly installation: GithubInstallationRecord;
  readonly trigger: GithubLabelEventTriggerRow;
  readonly labelNames: readonly string[];
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly sender: GithubUser;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const gateEnabled = await args.get(
    workflowGithubLabelEventTriggersEnabledForOwner(
      args.trigger.trigger.orgId,
      args.trigger.trigger.ownerUserId,
    ),
  );
  args.signal.throwIfAborted();
  if (!gateEnabled) {
    return null;
  }
  if (
    !subjectMatchesConfig({
      subjectKind: args.subjectKind,
      config: args.trigger.config,
    })
  ) {
    return null;
  }
  const matchedLabelName = matchingLabelName({
    labelNames: args.labelNames,
    config: args.trigger.config,
  });
  if (!matchedLabelName) {
    return null;
  }
  const actorMatches = await actorMatchesConfig({
    db: args.db,
    installation: args.installation,
    trigger: args.trigger,
    sender: args.sender,
  });
  args.signal.throwIfAborted();
  return actorMatches ? matchedLabelName : null;
}

async function dispatchMatchedGithubTriggers(args: {
  readonly get: Getter;
  readonly db: Db;
  readonly installation: GithubInstallationRecord;
  readonly triggers: readonly GithubLabelEventTriggerRow[];
  readonly labelNames: readonly string[];
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly startRun: GithubWorkflowRunStarter;
  readonly signal: AbortSignal;
}): Promise<GithubWorkflowDispatchCounts> {
  let dispatched = 0;
  let duplicates = 0;
  for (const trigger of args.triggers) {
    const matchedLabelName = await matchedLabelForTrigger({
      get: args.get,
      db: args.db,
      installation: args.installation,
      trigger,
      labelNames: args.labelNames,
      subjectKind: args.subjectKind,
      sender: args.payload.sender,
      signal: args.signal,
    });
    if (!matchedLabelName) {
      continue;
    }

    const result = await dispatchGithubTriggerEvent({
      db: args.db,
      trigger,
      deliveryId: args.deliveryId,
      payload: args.payload,
      subjectKind: args.subjectKind,
      matchedLabelName,
      startRun: args.startRun,
    });
    args.signal.throwIfAborted();
    if (typeof result !== "string") {
      log.warn("Failed to start GitHub label workflow run", {
        triggerId: trigger.trigger.id,
        deliveryId: args.deliveryId,
        repo: args.payload.repository.full_name,
        subjectNumber: args.payload.issue.number,
      });
      continue;
    }
    dispatched += result === "dispatched" ? 1 : 0;
    duplicates += result === "duplicate" ? 1 : 0;
  }
  return { dispatched, duplicates };
}

export const dispatchGithubLabelWorkflowTriggers$ = command(
  async (
    { get, set },
    args: {
      readonly deliveryId: string;
      readonly payload: GithubLabelWorkflowEventPayload;
      readonly subjectKind: GithubWorkflowSubjectKind;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly kind: "ok";
    readonly dispatched: number;
    readonly duplicates: number;
  }> => {
    const { action, issue, label, repository, installation } = args.payload;
    if (action !== "opened" && action !== "labeled") {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const labelNames = labelsForAction({
      action,
      labels: issue.labels,
      label,
    });
    if (labelNames.length === 0) {
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const db = set(writeDb$);
    const installationRecord = await findActiveInstallation({
      db,
      ghInstallationId: String(installation.id),
    });
    signal.throwIfAborted();
    if (!installationRecord) {
      log.debug("Ignoring GitHub workflow event for unbound installation", {
        action,
        installationId: String(installation.id),
        repo: repository.full_name,
      });
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const triggers = await loadGithubLabelEventTriggers({
      db,
      orgId: installationRecord.orgId,
      signal,
    });
    const counts = await dispatchMatchedGithubTriggers({
      get,
      db,
      installation: installationRecord,
      triggers,
      labelNames,
      deliveryId: args.deliveryId,
      payload: args.payload,
      subjectKind: args.subjectKind,
      startRun: createGithubWorkflowRunStarter({
        set,
        apiStartTime: args.apiStartTime,
        signal,
      }),
      signal,
    });

    return { kind: "ok", ...counts };
  },
);
