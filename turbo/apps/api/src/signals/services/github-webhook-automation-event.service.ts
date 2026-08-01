import { command } from "ccstate";
import { and, asc, eq } from "drizzle-orm";

import {
  githubDeploymentStatusCreatedEventConfigSchema,
  githubIssueCommentCreatedEventConfigSchema,
  githubPullRequestReviewSubmittedEventConfigSchema,
  githubWorkflowJobCompletedEventConfigSchema,
  type GithubDeploymentState,
  type GithubDeploymentStatusCreatedEventConfig,
  type GithubIssueCommentCreatedEventConfig,
  type GithubPullRequestReviewState,
  type GithubPullRequestReviewSubmittedEventConfig,
  type GithubWorkflowJobCompletedEventConfig,
  type GithubWorkflowRunConclusion,
  type GithubWorkflowEventConfig,
  type ZeroWorkflowEventType,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import {
  workflowUserAutomationThreads,
  zeroWorkflowAutomations,
  zeroWorkflowGithubProcessedEvents,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";

import { logger } from "../../lib/log";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { workflowAutomationCanFire } from "./zero-workflow-automation-access.service";
import {
  buildChatOnlyWorkflowAutomationCallbacks,
  runWorkflowAutomationNow$,
  type AutomationRow,
} from "./zero-workflow-automation-run.service";
import {
  workflowAutomationAppendSystemPrompt,
  workflowAutomationPrompt,
  type WorkflowAutomationContext,
} from "./workflow-automation-context.service";
import { ensureWorkflowUserAutomationThread } from "./zero-workflow-user-automation-thread.service";
import {
  WorkflowEventSourceTiming,
  type WorkflowEventRunTiming,
} from "./workflow-event-source-timing.service";

const log = logger("api:github-webhook-automation-event");

export interface GithubWebhookUser {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

interface GithubWebhookRepository {
  readonly id?: number;
  readonly full_name: string;
}

interface GithubWebhookInstallation {
  readonly id: number;
}

export interface GithubWorkflowJobEventPayload {
  readonly action: string;
  readonly workflow_job: {
    readonly id: number;
    readonly run_id: number;
    readonly workflow_name: string | null;
    readonly head_branch: string | null;
    readonly head_sha: string;
    readonly run_url: string;
    readonly run_attempt: number;
    readonly name: string;
    readonly status: string;
    readonly conclusion: GithubWorkflowRunConclusion | null;
    readonly html_url: string;
    readonly labels: readonly string[];
    readonly runner_id: number | null;
    readonly runner_name: string | null;
    readonly runner_group_id: number | null;
    readonly runner_group_name: string | null;
  };
  readonly repository: GithubWebhookRepository;
  readonly installation: GithubWebhookInstallation;
  readonly sender: GithubWebhookUser;
}

export interface GithubPullRequestReviewEventPayload {
  readonly action: string;
  readonly review: {
    readonly id: number;
    readonly user: GithubWebhookUser;
    readonly state: GithubPullRequestReviewState;
    readonly html_url: string;
    readonly commit_id: string;
    readonly submitted_at: string | null;
    readonly author_association: string;
  };
  readonly pull_request: {
    readonly number: number;
    readonly title: string;
    readonly html_url: string;
    readonly draft: boolean;
    readonly base: { readonly ref: string };
    readonly head: { readonly ref: string };
  };
  readonly repository: GithubWebhookRepository;
  readonly installation: GithubWebhookInstallation;
  readonly sender: GithubWebhookUser;
}

interface GithubAppReference {
  readonly id: number;
  readonly slug: string | null;
  readonly name: string | null;
}

export interface GithubDeploymentStatusEventPayload {
  readonly action: string;
  readonly deployment_status: {
    readonly id: number;
    readonly state: GithubDeploymentState;
    readonly environment: string | null;
    readonly environment_url: string | null;
    readonly log_url: string | null;
    readonly creator: GithubWebhookUser | null;
  };
  readonly deployment: {
    readonly id: number;
    readonly ref: string;
    readonly sha: string;
    readonly task: string;
    readonly environment: string;
    readonly production_environment: boolean;
    readonly transient_environment: boolean;
    readonly creator: GithubWebhookUser | null;
    readonly performed_via_github_app: GithubAppReference | null;
  };
  readonly repository: GithubWebhookRepository;
  readonly installation: GithubWebhookInstallation;
  readonly sender: GithubWebhookUser;
}

export interface GithubIssueCommentEventPayload {
  readonly action: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly html_url?: string;
    readonly pull_request?: Readonly<Record<string, unknown>>;
  };
  readonly comment: {
    readonly id: number;
    readonly body: string;
    readonly html_url?: string;
    readonly user: GithubWebhookUser;
    readonly author_association?: string;
  };
  readonly repository: GithubWebhookRepository;
  readonly installation: GithubWebhookInstallation;
  readonly sender: GithubWebhookUser;
}

type GithubWebhookAutomationEventType = Extract<
  ZeroWorkflowEventType,
  | "github-deployment-status-created"
  | "github-issue-comment-created"
  | "github-pull-request-review-submitted"
  | "github-workflow-job-completed"
>;

type GithubWebhookAutomationEventConfig = Extract<
  GithubWorkflowEventConfig,
  | { readonly event: "deployment_status_created" }
  | { readonly event: "issue_comment_created" }
  | { readonly event: "pull_request_review_submitted" }
  | { readonly event: "workflow_job_completed" }
>;

type GithubWebhookAutomationEvent =
  | {
      readonly eventType: "github-workflow-job-completed";
      readonly webhookEvent: "workflow_job";
      readonly payload: GithubWorkflowJobEventPayload;
    }
  | {
      readonly eventType: "github-pull-request-review-submitted";
      readonly webhookEvent: "pull_request_review";
      readonly payload: GithubPullRequestReviewEventPayload;
    }
  | {
      readonly eventType: "github-deployment-status-created";
      readonly webhookEvent: "deployment_status";
      readonly payload: GithubDeploymentStatusEventPayload;
    }
  | {
      readonly eventType: "github-issue-comment-created";
      readonly webhookEvent: "issue_comment";
      readonly payload: GithubIssueCommentEventPayload;
    };

type GithubInstallationRecord = typeof githubInstallations.$inferSelect;

interface GithubWebhookAutomationRow {
  readonly automation: AutomationRow;
  readonly agentId: string;
  readonly workflowName: string;
  readonly chatThreadId: string;
  readonly config: GithubWebhookAutomationEventConfig;
}

function parseConfigForEventType(
  eventType: GithubWebhookAutomationEventType,
  eventConfig: unknown,
): GithubWebhookAutomationEventConfig | null {
  switch (eventType) {
    case "github-workflow-job-completed": {
      const parsed =
        githubWorkflowJobCompletedEventConfigSchema.safeParse(eventConfig);
      return parsed.success ? parsed.data : null;
    }
    case "github-pull-request-review-submitted": {
      const parsed =
        githubPullRequestReviewSubmittedEventConfigSchema.safeParse(
          eventConfig,
        );
      return parsed.success ? parsed.data : null;
    }
    case "github-deployment-status-created": {
      const parsed =
        githubDeploymentStatusCreatedEventConfigSchema.safeParse(eventConfig);
      return parsed.success ? parsed.data : null;
    }
    case "github-issue-comment-created": {
      const parsed =
        githubIssueCommentCreatedEventConfigSchema.safeParse(eventConfig);
      return parsed.success ? parsed.data : null;
    }
  }
}

export async function prepareGithubWebhookEventConfigForPersist(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly eventType: GithubWebhookAutomationEventType;
    readonly eventConfig: GithubWebhookAutomationEventConfig;
  },
): Promise<
  | {
      readonly kind: "ok";
      readonly eventConfig: GithubWebhookAutomationEventConfig;
    }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const [installation] = await db
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.orgId, args.orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  if (!installation) {
    return {
      kind: "bad-request",
      message: "Install GitHub before creating GitHub webhook automations",
    };
  }

  const eventConfig = parseConfigForEventType(args.eventType, args.eventConfig);
  if (!eventConfig) {
    return {
      kind: "bad-request",
      message: "eventConfig must match the GitHub automation type",
    };
  }
  return { kind: "ok", eventConfig };
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function matchesNormalizedFilter(
  values: readonly string[] | undefined,
  actualValues: readonly (string | number | null | undefined)[],
): boolean {
  if (!values) {
    return true;
  }
  const normalizedActual = new Set(
    actualValues
      .filter((value): value is string | number => {
        return value !== null && value !== undefined;
      })
      .map((value) => {
        return normalized(String(value));
      }),
  );
  return values.some((value) => {
    return normalizedActual.has(normalized(value));
  });
}

function matchesExactFilter(
  values: readonly string[] | undefined,
  actualValue: string | null,
): boolean {
  return !values || (actualValue !== null && values.includes(actualValue));
}

function workflowJobMatchesConfig(
  config: GithubWorkflowJobCompletedEventConfig,
  payload: GithubWorkflowJobEventPayload,
): boolean {
  const { filters } = config;
  const job = payload.workflow_job;
  return (
    job.conclusion !== null &&
    matchesNormalizedFilter(filters.repositories, [
      payload.repository.full_name,
      payload.repository.id,
    ]) &&
    matchesNormalizedFilter(filters.workflows, [job.workflow_name]) &&
    matchesNormalizedFilter(filters.jobs, [job.name, job.id]) &&
    (!filters.conclusions || filters.conclusions.includes(job.conclusion)) &&
    matchesExactFilter(filters.branches, job.head_branch) &&
    matchesNormalizedFilter(filters.runnerLabels, job.labels) &&
    matchesNormalizedFilter(filters.runnerGroups, [
      job.runner_group_name,
      job.runner_group_id,
    ])
  );
}

function pullRequestReviewMatchesConfig(
  config: GithubPullRequestReviewSubmittedEventConfig,
  payload: GithubPullRequestReviewEventPayload,
): boolean {
  const { filters } = config;
  return (
    matchesNormalizedFilter(filters.repositories, [
      payload.repository.full_name,
      payload.repository.id,
    ]) &&
    (!filters.reviewStates ||
      filters.reviewStates.includes(payload.review.state)) &&
    matchesExactFilter(filters.baseBranches, payload.pull_request.base.ref) &&
    matchesExactFilter(filters.headBranches, payload.pull_request.head.ref) &&
    matchesNormalizedFilter(filters.trustedAuthors, [payload.review.user.login])
  );
}

function deploymentStatusMatchesConfig(
  config: GithubDeploymentStatusCreatedEventConfig,
  payload: GithubDeploymentStatusEventPayload,
): boolean {
  const { filters } = config;
  const status = payload.deployment_status;
  const deployment = payload.deployment;
  const app = deployment.performed_via_github_app;
  return (
    matchesNormalizedFilter(filters.repositories, [
      payload.repository.full_name,
      payload.repository.id,
    ]) &&
    matchesNormalizedFilter(filters.environments, [
      status.environment,
      deployment.environment,
    ]) &&
    (!filters.states || filters.states.includes(status.state)) &&
    matchesExactFilter(filters.refs, deployment.ref) &&
    (filters.productionEnvironment === undefined ||
      filters.productionEnvironment === deployment.production_environment) &&
    matchesNormalizedFilter(filters.creators, [
      status.creator?.login,
      status.creator?.id,
      deployment.creator?.login,
      deployment.creator?.id,
    ]) &&
    matchesNormalizedFilter(filters.apps, [app?.slug, app?.name, app?.id])
  );
}

function issueCommentMatchesConfig(
  config: GithubIssueCommentCreatedEventConfig,
  payload: GithubIssueCommentEventPayload,
): boolean {
  const { filters } = config;
  const isPullRequest = payload.issue.pull_request !== undefined;
  const subjectMatches =
    filters.subject === "both" ||
    (filters.subject === "pull_requests" && isPullRequest) ||
    (filters.subject === "issues" && !isPullRequest);
  const trimmedBody = payload.comment.body.trim();
  return (
    matchesNormalizedFilter(filters.repositories, [
      payload.repository.full_name,
      payload.repository.id,
    ]) &&
    subjectMatches &&
    matchesNormalizedFilter(filters.trustedAuthors, [
      payload.comment.user.login,
    ]) &&
    (!filters.commentPrefixes ||
      filters.commentPrefixes.some((prefix) => {
        return trimmedBody.startsWith(prefix);
      }))
  );
}

function eventCanDispatch(event: GithubWebhookAutomationEvent): boolean {
  switch (event.eventType) {
    case "github-workflow-job-completed": {
      return (
        event.payload.action === "completed" &&
        event.payload.workflow_job.conclusion !== null
      );
    }
    case "github-pull-request-review-submitted": {
      return event.payload.action === "submitted";
    }
    case "github-deployment-status-created": {
      return event.payload.action === "created";
    }
    case "github-issue-comment-created": {
      return event.payload.action === "created";
    }
  }
}

function eventMatchesAutomation(
  event: GithubWebhookAutomationEvent,
  config: GithubWebhookAutomationEventConfig,
): boolean {
  switch (event.eventType) {
    case "github-workflow-job-completed": {
      const parsed =
        githubWorkflowJobCompletedEventConfigSchema.safeParse(config);
      return (
        parsed.success && workflowJobMatchesConfig(parsed.data, event.payload)
      );
    }
    case "github-pull-request-review-submitted": {
      const parsed =
        githubPullRequestReviewSubmittedEventConfigSchema.safeParse(config);
      return (
        parsed.success &&
        pullRequestReviewMatchesConfig(parsed.data, event.payload)
      );
    }
    case "github-deployment-status-created": {
      const parsed =
        githubDeploymentStatusCreatedEventConfigSchema.safeParse(config);
      return (
        parsed.success &&
        deploymentStatusMatchesConfig(parsed.data, event.payload)
      );
    }
    case "github-issue-comment-created": {
      const parsed =
        githubIssueCommentCreatedEventConfigSchema.safeParse(config);
      return (
        parsed.success && issueCommentMatchesConfig(parsed.data, event.payload)
      );
    }
  }
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

async function loadGithubWebhookAutomations(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly eventType: GithubWebhookAutomationEventType;
  readonly signal: AbortSignal;
}): Promise<readonly GithubWebhookAutomationRow[]> {
  const rows = await args.db
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
        eq(zeroWorkflowAutomations.eventType, args.eventType),
      ),
    )
    .orderBy(asc(zeroWorkflowAutomations.createdAt));
  args.signal.throwIfAborted();

  const automations: GithubWebhookAutomationRow[] = [];
  const currentTime = nowDate();
  for (const row of rows) {
    const config = parseConfigForEventType(
      args.eventType,
      row.automation.eventConfig,
    );
    if (!config) {
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
      config,
    });
  }
  return automations;
}

function eventRepository(event: GithubWebhookAutomationEvent) {
  return event.payload.repository;
}

function eventInstallation(event: GithubWebhookAutomationEvent) {
  return event.payload.installation;
}

function eventAction(event: GithubWebhookAutomationEvent): string {
  return event.payload.action;
}

function eventSubject(event: GithubWebhookAutomationEvent): {
  readonly type: "issue" | "pull_request" | null;
  readonly number: number | null;
} {
  switch (event.eventType) {
    case "github-pull-request-review-submitted": {
      return {
        type: "pull_request",
        number: event.payload.pull_request.number,
      };
    }
    case "github-issue-comment-created": {
      return {
        type:
          event.payload.issue.pull_request === undefined
            ? "issue"
            : "pull_request",
        number: event.payload.issue.number,
      };
    }
    case "github-deployment-status-created":
    case "github-workflow-job-completed": {
      return { type: null, number: null };
    }
  }
}

async function recordProcessedDelivery(args: {
  readonly db: Db;
  readonly automation: GithubWebhookAutomationRow;
  readonly deliveryId: string;
  readonly event: GithubWebhookAutomationEvent;
}): Promise<string | null> {
  const subject = eventSubject(args.event);
  const [row] = await args.db
    .insert(zeroWorkflowGithubProcessedEvents)
    .values({
      automationId: args.automation.automation.id,
      githubDeliveryId: args.deliveryId,
      repo: eventRepository(args.event).full_name,
      subjectType: subject.type,
      subjectNumber: subject.number,
      action: eventAction(args.event),
      labelNameNormalized: null,
      createdAt: nowDate(),
    })
    .onConflictDoNothing()
    .returning({ id: zeroWorkflowGithubProcessedEvents.id });
  return row?.id ?? null;
}

function eventPromptSummary(event: GithubWebhookAutomationEvent): string {
  switch (event.eventType) {
    case "github-workflow-job-completed": {
      const job = event.payload.workflow_job;
      return `the GitHub Actions job "${job.name}" completed with conclusion "${job.conclusion}"`;
    }
    case "github-pull-request-review-submitted": {
      const review = event.payload.review;
      return `GitHub user "${review.user.login}" submitted a pull request review with state "${review.state}"`;
    }
    case "github-deployment-status-created": {
      const status = event.payload.deployment_status;
      return `a GitHub deployment status changed to "${status.state}"`;
    }
    case "github-issue-comment-created": {
      return `GitHub user "${event.payload.comment.user.login}" created a comment`;
    }
  }
}

function eventPromptMetadata(
  event: GithubWebhookAutomationEvent,
): Readonly<Record<string, unknown>> {
  const repository = eventRepository(event);
  const common = {
    event: event.webhookEvent,
    action: eventAction(event),
    repository: { id: repository.id, fullName: repository.full_name },
  };
  switch (event.eventType) {
    case "github-workflow-job-completed": {
      const job = event.payload.workflow_job;
      return {
        ...common,
        job: {
          id: job.id,
          runId: job.run_id,
          workflowName: job.workflow_name,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          url: job.html_url,
          runUrl: job.run_url,
          runAttempt: job.run_attempt,
          branch: job.head_branch,
          commitSha: job.head_sha,
          runner: {
            id: job.runner_id,
            name: job.runner_name,
            groupId: job.runner_group_id,
            groupName: job.runner_group_name,
            labels: job.labels,
          },
        },
      };
    }
    case "github-pull-request-review-submitted": {
      const review = event.payload.review;
      const pullRequest = event.payload.pull_request;
      return {
        ...common,
        review: {
          id: review.id,
          state: review.state,
          url: review.html_url,
          commitId: review.commit_id,
          submittedAt: review.submitted_at,
          author: review.user,
          authorAssociation: review.author_association,
        },
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          url: pullRequest.html_url,
          draft: pullRequest.draft,
          baseBranch: pullRequest.base.ref,
          headBranch: pullRequest.head.ref,
        },
      };
    }
    case "github-deployment-status-created": {
      const status = event.payload.deployment_status;
      const deployment = event.payload.deployment;
      return {
        ...common,
        deploymentStatus: {
          id: status.id,
          state: status.state,
          environment: status.environment,
          environmentUrl: status.environment_url,
          logUrl: status.log_url,
          creator: status.creator,
        },
        deployment: {
          id: deployment.id,
          ref: deployment.ref,
          commitSha: deployment.sha,
          task: deployment.task,
          environment: deployment.environment,
          productionEnvironment: deployment.production_environment,
          transientEnvironment: deployment.transient_environment,
          creator: deployment.creator,
          app: deployment.performed_via_github_app,
        },
      };
    }
    case "github-issue-comment-created": {
      const subjectType =
        event.payload.issue.pull_request === undefined
          ? "issue"
          : "pull_request";
      return {
        ...common,
        comment: {
          id: event.payload.comment.id,
          url: event.payload.comment.html_url,
          author: event.payload.comment.user,
          authorAssociation: event.payload.comment.author_association,
          bodyIncluded: false,
        },
        subject: {
          type: subjectType,
          number: event.payload.issue.number,
          title: event.payload.issue.title,
          url: event.payload.issue.html_url,
        },
      };
    }
  }
}

function githubWebhookTriggerContext(args: {
  readonly automation: GithubWebhookAutomationRow;
  readonly deliveryId: string;
  readonly event: GithubWebhookAutomationEvent;
}): WorkflowAutomationContext {
  return {
    workflowName: args.automation.workflowName,
    eventType: args.event.eventType,
    trigger: `${eventPromptSummary(args.event)} (GitHub webhook delivery ${args.deliveryId}).`,
    notes: [
      "Not included below: user-authored review and comment bodies, logs, and artifacts. Connected GitHub tools and the GitHub API return them.",
    ],
    event: {
      automationId: args.automation.automation.id,
      deliveryId: args.deliveryId,
      ...eventPromptMetadata(args.event),
    },
  };
}

const startGithubWebhookAutomation$ = command(
  async (
    { set },
    args: {
      readonly automation: GithubWebhookAutomationRow;
      readonly deliveryId: string;
      readonly event: GithubWebhookAutomationEvent;
      readonly apiStartTime: number;
      readonly timing: WorkflowEventRunTiming;
    },
    signal: AbortSignal,
  ): Promise<"ok" | "error"> => {
    const context = githubWebhookTriggerContext(args);
    const result = await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation: args.automation.automation,
          agentId: args.automation.agentId,
          workflowName: args.automation.workflowName,
          chatThreadId: args.automation.chatThreadId,
        },
        automationContext: context,
        apiStartTime: args.apiStartTime,
        triggerSource: "workflow-event",
        prompt: workflowAutomationPrompt(context),
        appendSystemPrompt: workflowAutomationAppendSystemPrompt(context),
        callbacks: buildChatOnlyWorkflowAutomationCallbacks(
          args.automation.chatThreadId,
          args.automation.agentId,
        ),
        activePreviousRunPolicy: "allow",
        recordLastRunId: false,
        recordLastRunAt: true,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        timing: args.timing.collectorForRunStart(),
      },
      signal,
    );
    signal.throwIfAborted();
    return result.kind === "ok" || result.kind === "enqueued" ? "ok" : "error";
  },
);

export const dispatchGithubWebhookAutomations$ = command(
  async (
    { set },
    args: {
      readonly deliveryId: string;
      readonly event: GithubWebhookAutomationEvent;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt?: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly kind: "ok";
    readonly dispatched: number;
    readonly duplicates: number;
  }> => {
    if (!eventCanDispatch(args.event)) {
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
    const installation = await sourceTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_load_source_state",
      async () => {
        return await findActiveInstallation({
          db,
          ghInstallationId: String(eventInstallation(args.event).id),
        });
      },
    );
    signal.throwIfAborted();
    if (!installation) {
      log.debug("Ignoring GitHub webhook for unbound installation", {
        event: args.event.webhookEvent,
        installationId: String(eventInstallation(args.event).id),
        repository: eventRepository(args.event).full_name,
      });
      return { kind: "ok", dispatched: 0, duplicates: 0 };
    }

    const automations = await sourceTiming.measure(
      "api_dispatch_pre_create_zero_workflow_event_load_automations",
      async () => {
        return await loadGithubWebhookAutomations({
          db,
          orgId: installation.orgId,
          eventType: args.event.eventType,
          signal,
        });
      },
    );
    signal.throwIfAborted();

    let dispatched = 0;
    let duplicates = 0;
    for (const automation of automations) {
      const runTiming = sourceTiming.createRunTiming();
      const matches = await runTiming.measure(
        "api_dispatch_pre_create_zero_workflow_event_match_automations",
        () => {
          return eventMatchesAutomation(args.event, automation.config);
        },
      );
      signal.throwIfAborted();
      if (!matches) {
        continue;
      }
      const processedId = await runTiming.measure(
        "api_dispatch_pre_create_zero_workflow_event_record_processed_event",
        async () => {
          return await recordProcessedDelivery({
            db,
            automation,
            deliveryId: args.deliveryId,
            event: args.event,
          });
        },
      );
      signal.throwIfAborted();
      if (!processedId) {
        duplicates += 1;
        continue;
      }

      const result = await set(
        startGithubWebhookAutomation$,
        {
          automation,
          deliveryId: args.deliveryId,
          event: args.event,
          apiStartTime: args.apiStartTime,
          timing: runTiming,
        },
        signal,
      );
      signal.throwIfAborted();
      if (result === "ok") {
        dispatched += 1;
        continue;
      }
      await db
        .delete(zeroWorkflowGithubProcessedEvents)
        .where(eq(zeroWorkflowGithubProcessedEvents.id, processedId));
      signal.throwIfAborted();
      log.warn("Failed to start GitHub webhook automation", {
        automationId: automation.automation.id,
        deliveryId: args.deliveryId,
        event: args.event.webhookEvent,
      });
    }

    return { kind: "ok", dispatched, duplicates };
  },
);
