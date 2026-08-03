import { command } from "ccstate";
import { and, asc, eq } from "drizzle-orm";

import {
  githubLabelAppliedEventConfigSchema,
  type GithubLabelAppliedEventConfig,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import {
  workflowUserAutomationThreads,
  zeroWorkflowGithubProcessedEvents,
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { logger } from "../../lib/log";
import { testOverride } from "../../lib/singleton";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  WorkflowEventSourceTiming,
  type WorkflowEventRunTiming,
} from "./workflow-event-source-timing.service";
import {
  runWorkflowAutomationNow$,
  type AutomationRow,
} from "./zero-workflow-automation-run.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import { ensureWorkflowUserAutomationThread } from "./zero-workflow-user-automation-thread.service";

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

interface GithubLabelEventAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GithubLabelAppliedEventConfig;
}

type GithubWorkflowRunStartArgs = {
  readonly automation: GithubLabelEventAutomationRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly matchedLabelName: string;
  readonly timing: WorkflowEventRunTiming;
};

interface GithubWorkflowDispatchCounts {
  readonly dispatched: number;
  readonly duplicates: number;
}

interface GithubWorkflowRunStartTestInput {
  readonly automationId: string;
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

function normalizeGithubWorkflowLabelName(labelName: string): string {
  return labelName.trim().toLowerCase();
}

async function loadOrgGithubWorkflowInstallation(
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
      message:
        "Install GitHub before creating GitHub label workflow automations",
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
          "Connect your GitHub account before using Triggered by me for GitHub label workflow automations",
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
  readonly automation: GithubLabelEventAutomationRow;
  readonly sender: GithubUser;
}): Promise<boolean> {
  if (args.automation.config.filters.actor.type === "anyone") {
    return true;
  }
  const link = await loadGithubUserLink({
    db: args.db,
    installationId: args.installation.id,
    userId: args.automation.automation.ownerUserId,
  });
  return link?.githubUserId === String(args.sender.id);
}

async function loadGithubLabelEventAutomations(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<readonly GithubLabelEventAutomationRow[]> {
  const automationRows = await args.db
    .select({
      automation: zeroWorkflowAutomations,
      agentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
      chatThreadId: workflowUserAutomationThreads.chatThreadId,
    })
    .from(zeroWorkflowAutomations)
    .innerJoin(
      zeroWorkflows,
      eq(zeroWorkflowAutomations.workflowId, zeroWorkflows.id),
    )
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, zeroWorkflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          zeroWorkflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          zeroWorkflowAutomations.workflowId,
        ),
      ),
    )
    .where(
      and(
        eq(zeroWorkflowAutomations.orgId, args.orgId),
        eq(zeroWorkflowAutomations.enabled, true),
        eq(zeroWorkflowAutomations.kind, "event"),
        eq(zeroWorkflowAutomations.eventType, "github-label-applied"),
      ),
    )
    .orderBy(asc(zeroWorkflowAutomations.createdAt));
  args.signal.throwIfAborted();

  const currentTime = nowDate();
  const automations: GithubLabelEventAutomationRow[] = [];
  for (const row of automationRows) {
    const config = githubLabelAppliedEventConfigSchema.safeParse(
      row.automation.eventConfig,
    );
    if (!config.success) {
      continue;
    }
    const canFire = await workflowAutomationCanFire(args.db, {
      automation: row.automation,
      agentId: row.agentId,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    if (!canFire) {
      continue;
    }
    const chatThreadId =
      row.chatThreadId ??
      (await args.db.transaction(async (tx) => {
        return await ensureWorkflowUserAutomationThread(tx, {
          orgId: row.automation.orgId,
          userId: row.automation.ownerUserId,
          workflowId: row.automation.workflowId,
          agentId: row.agentId,
          workflowTitle: row.workflowDisplayName ?? row.workflowName,
          currentTime,
        });
      }));
    args.signal.throwIfAborted();
    automations.push({
      automation: row.automation,
      agentId: row.agentId,
      workflowName: row.workflowName,
      chatThreadId,
      config: config.data,
    });
  }
  return automations;
}

async function insertGithubProcessedEvent(args: {
  readonly db: Db;
  readonly automation: GithubLabelEventAutomationRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
}): Promise<string | null> {
  const [processed] = await args.db
    .insert(zeroWorkflowGithubProcessedEvents)
    .values({
      automationId: args.automation.automation.id,
      githubDeliveryId: args.deliveryId,
      repo: args.payload.repository.full_name,
      subjectType: args.subjectKind,
      subjectNumber: args.payload.issue.number,
      action: args.payload.action,
      labelNameNormalized: normalizeGithubWorkflowLabelName(
        args.automation.config.labelName,
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

function githubLabelTriggerContext(args: {
  readonly automation: GithubLabelEventAutomationRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly matchedLabelName: string;
}): WorkflowAutomationContext {
  const subjectLabel =
    args.subjectKind === "pull_request" ? "pull request" : "issue";
  return {
    workflowName: args.automation.workflowName,
    eventType: "github-label-applied",
    trigger: `GitHub label "${args.matchedLabelName}" was applied to ${subjectLabel} #${args.payload.issue.number} (GitHub webhook delivery ${args.deliveryId}).`,
    notes: [
      "Not included below: the issue or pull request body, comments, files, and diffs. Connected GitHub tools and the GitHub API return them.",
    ],
    event: {
      automationId: args.automation.automation.id,
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
  };
}

async function dispatchGithubAutomationEvent(args: {
  readonly db: Db;
  readonly automation: GithubLabelEventAutomationRow;
  readonly deliveryId: string;
  readonly payload: GithubLabelWorkflowEventPayload;
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly matchedLabelName: string;
  readonly timing: WorkflowEventRunTiming;
  readonly startRun: () => Promise<"ok" | "error">;
}): Promise<"dispatched" | "duplicate" | { readonly kind: "run_error" }> {
  const processedId = await args.timing.measure(
    "api_dispatch_pre_create_zero_workflow_event_record_processed_event",
    async () => {
      return await insertGithubProcessedEvent(args);
    },
  );
  if (!processedId) {
    return "duplicate";
  }

  const result = await args.startRun();
  if (result !== "ok") {
    await args.db
      .delete(zeroWorkflowGithubProcessedEvents)
      .where(eq(zeroWorkflowGithubProcessedEvents.id, processedId));
    return { kind: "run_error" };
  }

  return "dispatched";
}

const startGithubWorkflowRun$ = command(
  async (
    { set },
    args: GithubWorkflowRunStartArgs & {
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "error"> => {
    const runInput = await args.timing.measure(
      "api_dispatch_pre_create_zero_workflow_event_build_run_input",
      () => {
        const context = githubLabelTriggerContext(args);
        return { context };
      },
    );
    signal.throwIfAborted();
    const result = await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation: args.automation.automation,
          agentId: args.automation.agentId,
          chatThreadId: args.automation.chatThreadId,
        },
        automationContext: runInput.context,
        apiStartTime: args.apiStartTime,
        triggerSource: "workflow-event",
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        timing: args.timing.collectorForRunStart(),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok" || result.kind === "enqueued" ? "ok" : "error";
  },
);

async function startGithubWorkflowRunOverride(
  args: GithubWorkflowRunStartArgs,
): Promise<"ok" | "error" | null> {
  const runStarterOverride = githubWorkflowRunStarterOverride.get();
  if (!runStarterOverride) {
    return null;
  }
  return await runStarterOverride({
    automationId: args.automation.automation.id,
    workflowName: args.automation.workflowName,
    deliveryId: args.deliveryId,
    repo: args.payload.repository.full_name,
    subjectType: args.subjectKind,
    subjectNumber: args.payload.issue.number,
    action: args.payload.action,
    labelName: args.matchedLabelName,
    actorLogin: args.payload.sender.login,
  });
}

async function matchedLabelForAutomation(args: {
  readonly db: Db;
  readonly installation: GithubInstallationRecord;
  readonly automation: GithubLabelEventAutomationRow;
  readonly labelNames: readonly string[];
  readonly subjectKind: GithubWorkflowSubjectKind;
  readonly sender: GithubUser;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  if (
    !subjectMatchesConfig({
      subjectKind: args.subjectKind,
      config: args.automation.config,
    })
  ) {
    return null;
  }
  const matchedLabelName = matchingLabelName({
    labelNames: args.labelNames,
    config: args.automation.config,
  });
  if (!matchedLabelName) {
    return null;
  }
  const actorMatches = await actorMatchesConfig({
    db: args.db,
    installation: args.installation,
    automation: args.automation,
    sender: args.sender,
  });
  args.signal.throwIfAborted();
  return actorMatches ? matchedLabelName : null;
}

const dispatchMatchedGithubAutomations$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly installation: GithubInstallationRecord;
      readonly automations: readonly GithubLabelEventAutomationRow[];
      readonly labelNames: readonly string[];
      readonly deliveryId: string;
      readonly payload: GithubLabelWorkflowEventPayload;
      readonly subjectKind: GithubWorkflowSubjectKind;
      readonly apiStartTime: number;
      readonly sourceTiming: WorkflowEventSourceTiming;
    },
    signal: AbortSignal,
  ): Promise<GithubWorkflowDispatchCounts> => {
    let dispatched = 0;
    let duplicates = 0;
    for (const automation of args.automations) {
      const runTiming = args.sourceTiming.createRunTiming();
      const matchedLabelName = await runTiming.measure(
        "api_dispatch_pre_create_zero_workflow_event_match_automations",
        async () => {
          return await matchedLabelForAutomation({
            db: args.db,
            installation: args.installation,
            automation,
            labelNames: args.labelNames,
            subjectKind: args.subjectKind,
            sender: args.payload.sender,
            signal,
          });
        },
      );
      signal.throwIfAborted();
      if (!matchedLabelName) {
        continue;
      }

      const runArgs = {
        automation,
        deliveryId: args.deliveryId,
        payload: args.payload,
        subjectKind: args.subjectKind,
        matchedLabelName,
        timing: runTiming,
      };
      const result = await dispatchGithubAutomationEvent({
        db: args.db,
        automation,
        deliveryId: args.deliveryId,
        payload: args.payload,
        subjectKind: args.subjectKind,
        matchedLabelName,
        timing: runTiming,
        startRun: async () => {
          return (
            (await startGithubWorkflowRunOverride(runArgs)) ??
            (await set(
              startGithubWorkflowRun$,
              { ...runArgs, apiStartTime: args.apiStartTime },
              signal,
            ))
          );
        },
      });
      signal.throwIfAborted();
      if (typeof result !== "string") {
        log.warn("Failed to start GitHub label workflow run", {
          automationId: automation.automation.id,
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
  },
);

export const dispatchGithubLabelWorkflowAutomations$ = command(
  async (
    { set },
    args: {
      readonly deliveryId: string;
      readonly payload: GithubLabelWorkflowEventPayload;
      readonly subjectKind: GithubWorkflowSubjectKind;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt?: number;
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

    const sourceTiming = new WorkflowEventSourceTiming(
      "github",
      args.apiStartTime,
    );
    if (args.backgroundScheduledAt !== undefined) {
      sourceTiming.recordElapsed(
        "api_dispatch_pre_create_zero_workflow_event_background_start_gap",
        args.backgroundScheduledAt,
      );
    }

    const db = set(writeDb$);
    const installationRecord = await sourceTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_load_source_state",
      async () => {
        return await findActiveInstallation({
          db,
          ghInstallationId: String(installation.id),
        });
      },
    );
    signal.throwIfAborted();
    if (!installationRecord) {
      log.debug("Ignoring GitHub workflow event for unbound installation", {
        action,
        installationId: String(installation.id),
        repo: repository.full_name,
      });
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const automations = await sourceTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_load_automations",
      async () => {
        return await loadGithubLabelEventAutomations({
          db,
          orgId: installationRecord.orgId,
          signal,
        });
      },
    );
    signal.throwIfAborted();
    const counts = await set(
      dispatchMatchedGithubAutomations$,
      {
        db,
        installation: installationRecord,
        automations,
        labelNames,
        deliveryId: args.deliveryId,
        payload: args.payload,
        subjectKind: args.subjectKind,
        apiStartTime: args.apiStartTime,
        sourceTiming,
      },
      signal,
    );

    return { kind: "ok", ...counts };
  },
);
