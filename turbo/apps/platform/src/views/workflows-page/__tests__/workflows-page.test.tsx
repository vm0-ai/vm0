import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  type ZeroWorkflowTriggerCreateRequest,
  type ZeroWorkflowTriggerUpdateRequest,
  type ZeroWorkflowUpdateRequest,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { toast } from "@vm0/ui/components/ui/sonner";
import { afterEach, describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  patchWorkflowMetadataForm$,
  setWorkflowFileDraft$,
} from "../../../signals/workflows-page/workflows-signals.ts";
import { mockChatLifecycle } from "../../zero-page/__tests__/chat-test-helpers.ts";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../../zero-page/workflow-trigger-automations-page.tsx";

const context = testContext();
const CURRENT_USER_ID = "test-user-123";
const UPDATED_USER_ID = "test-user-456";
const AGENT_ID = "c0000000-0000-4000-a000-000000000101";
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000102";
const SALES_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000201";
const OPS_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000202";
const OTHER_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000203";
const CHECKLIST_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000204";
const COPIED_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000205";
const GMAIL_TRIGGER_ID = "workflow-trigger-gmail-new-message";
const GMAIL_LABEL_TRIGGER_ID = "workflow-trigger-gmail-label-applied";
const GITHUB_LABEL_TRIGGER_ID = "workflow-trigger-github-label-applied";
const GOOGLE_CALENDAR_TRIGGER_ID = "workflow-trigger-google-calendar-created";
const GOOGLE_MEET_TRIGGER_ID = "workflow-trigger-google-meet-transcript";
const WORKFLOW_CHAT_THREAD_ID = "00000000-0000-4000-a000-000000000300";
const TRIGGER_RUN_THREAD_ID = "00000000-0000-4000-a000-000000000301";

type WorkflowDetailTestTab = "automations" | "instructions" | "info";

afterEach(() => {
  toast.dismiss();
});

function workflowDetailPath(tab: WorkflowDetailTestTab): string {
  return `/workflows/${SALES_WORKFLOW_ID}/${tab}`;
}

function detachedSetupWorkflowDetailPage(
  path: string,
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
) {
  detachedSetupPage({
    context,
    path,
    featureSwitches: {
      [FeatureSwitchKey.WorkflowAutomation]: true,
      ...featureSwitches,
    },
  });
}

async function findComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

async function expectComposerText(text: string): Promise<void> {
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(editor.textContent).toContain(text);
  });
}

type WorkflowScheduleTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "schedule" }
>;
type WorkflowGmailNewMessageTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "gmail-new-message" }
>;
type WorkflowWebhookTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "webhook-received" }
>;
type WorkflowGmailLabelAppliedTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "gmail-label-applied" }
>;
type WorkflowGithubLabelAppliedTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "github-label-applied" }
>;
type WorkflowGoogleCalendarEventCreatedTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "google-calendar-event-created" }
>;
type WorkflowGoogleCalendarEventUpdatedTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "google-calendar-event-updated" }
>;
type WorkflowGoogleCalendarEventCancelledTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "google-calendar-event-cancelled" }
>;
type WorkflowGoogleMeetTranscriptGeneratedTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event"; eventType: "google-meet-transcript-generated" }
>;

function workflowTriggers(): ZeroWorkflowTriggerSummary[] {
  return [weekdayWorkflowTrigger()];
}

function weekdayWorkflowTrigger(): WorkflowScheduleTriggerSummary {
  return {
    id: "workflow-trigger-weekday-brief",
    kind: "schedule",
    schedule: {
      type: "cron",
      cronExpression: "0 9 * * 1-5",
      timezone: "UTC",
    },
    scheduleSummary: "Weekdays at 9:00 AM",
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_weekday_brief",
    nextRunAt: "2026-06-19T01:00:00.000Z",
    lastRunAt: "2026-06-18T01:00:00.000Z",
  };
}

function gmailWorkflowTrigger(): WorkflowGmailNewMessageTriggerSummary {
  return {
    id: GMAIL_TRIGGER_ID,
    kind: "event",
    eventType: "gmail-new-message",
    eventConfig: {
      provider: "gmail",
      event: "new_message",
      match: {
        from: { contains: "@acme.com" },
        subject: { doesNotContain: "newsletter" },
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_gmail_new_message",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function gmailLabelWorkflowTrigger(): WorkflowGmailLabelAppliedTriggerSummary {
  return {
    id: GMAIL_LABEL_TRIGGER_ID,
    kind: "event",
    eventType: "gmail-label-applied",
    eventConfig: {
      provider: "gmail",
      event: "label_applied",
      labelName: "Support",
      resolvedLabelId: "Label_support",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_gmail_label_applied",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function githubLabelWorkflowTrigger(): WorkflowGithubLabelAppliedTriggerSummary {
  return {
    id: GITHUB_LABEL_TRIGGER_ID,
    kind: "event",
    eventType: "github-label-applied",
    eventConfig: {
      provider: "github",
      event: "label_applied",
      labelName: "triage",
      filters: {
        subject: "both",
        actor: { type: "me" },
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_github_label_applied",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function googleCalendarWorkflowTrigger(): WorkflowGoogleCalendarEventCreatedTriggerSummary {
  return {
    id: GOOGLE_CALENDAR_TRIGGER_ID,
    kind: "event",
    eventType: "google-calendar-event-created",
    eventConfig: {
      provider: "google-calendar",
      event: "event_created",
      calendarId: "primary",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_calendar_event_created",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function googleCalendarUpdatedWorkflowTrigger(): WorkflowGoogleCalendarEventUpdatedTriggerSummary {
  return {
    id: "workflow-trigger-google-calendar-updated",
    kind: "event",
    eventType: "google-calendar-event-updated",
    eventConfig: {
      provider: "google-calendar",
      event: "event_updated",
      calendarId: "primary",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_calendar_event_updated",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function googleCalendarCancelledWorkflowTrigger(): WorkflowGoogleCalendarEventCancelledTriggerSummary {
  return {
    id: "workflow-trigger-google-calendar-cancelled",
    kind: "event",
    eventType: "google-calendar-event-cancelled",
    eventConfig: {
      provider: "google-calendar",
      event: "event_cancelled",
      calendarId: "primary",
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_calendar_event_cancelled",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function googleMeetTranscriptGeneratedWorkflowTrigger(): WorkflowGoogleMeetTranscriptGeneratedTriggerSummary {
  return {
    id: GOOGLE_MEET_TRIGGER_ID,
    kind: "event",
    eventType: "google-meet-transcript-generated",
    eventConfig: {
      provider: "google-meet",
      event: "transcript_generated",
      scope: { type: "organizer_user" },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_google_meet_transcript_generated",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function webhookWorkflowTrigger(): WorkflowWebhookTriggerSummary {
  return {
    id: "workflow-trigger-webhook",
    kind: "event",
    eventType: "webhook-received",
    eventConfig: {
      provider: "webhook",
      event: "received",
      auth: { mode: "hmac-sha256" },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_webhook",
    nextRunAt: null,
    lastRunAt: null,
    webhookUrl: "https://api.vm0.test/api/webhooks/workflow-triggers/whk_test",
    secretLastFour: "abcd",
    lastReceivedAt: null,
  };
}

function publicWorkflowTrigger(
  trigger: ZeroWorkflowTriggerSummary,
): ZeroWorkflowTriggerSummary {
  if (trigger.kind !== "event" || trigger.eventType !== "webhook-received") {
    return trigger;
  }
  const {
    webhookUrl: _webhookUrl,
    webhookSecret: _webhookSecret,
    ...rest
  } = trigger;
  return rest;
}

function publicWorkflowDetail(
  detail: ZeroWorkflowDetailResponse,
): ZeroWorkflowDetailResponse {
  return {
    ...detail,
    triggers: detail.triggers.map(publicWorkflowTrigger),
  };
}

function salesResearch(): ZeroWorkflowDetailResponse {
  return {
    id: SALES_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "sales-research",
    displayName: "Sales Research",
    description: "Collects account context before outreach.",
    visibility: "public",
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: false,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: UPDATED_USER_ID,
    createdAt: "2026-06-17T13:52:00.000Z",
    updatedAt: "2026-06-20T14:16:00.000Z",
    instruction: "Gather CRM context before outreach.",
    files: [
      { path: "examples/prompt.md", size: 1536 },
      { path: "config/settings.json", size: 32 },
    ],
    fileContents: [
      {
        path: "examples/prompt.md",
        content: "# Prompt example\n\nAsk for market segment and urgency.\n",
      },
      {
        path: "config/settings.json",
        content: '{ "risk": "low", "tone": "direct" }',
      },
    ],
    triggers: workflowTriggers(),
  };
}

function opsPlaybook(): ZeroWorkflowDetailResponse {
  return {
    id: OPS_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "ops-playbook",
    displayName: "Ops Playbook",
    description: null,
    visibility: "private",
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: true,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: CURRENT_USER_ID,
    createdAt: "2026-06-15T12:00:00.000Z",
    updatedAt: "2026-06-15T12:00:00.000Z",
    instruction: null,
    files: [],
    fileContents: [],
    triggers: [],
  };
}

function launchChecklistWorkflow(): ZeroWorkflowDetailResponse {
  return {
    id: CHECKLIST_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "launch-checklist",
    displayName: "Launch Checklist",
    description: "Prepares release approvals.",
    visibility: "private",
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: true,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: CURRENT_USER_ID,
    createdAt: "2026-06-18T12:00:00.000Z",
    updatedAt: "2026-06-18T12:00:00.000Z",
    instruction: null,
    files: [],
    fileContents: [],
    triggers: [],
  };
}

function otherAgentWorkflow(): ZeroWorkflowDetailResponse {
  return {
    id: OTHER_WORKFLOW_ID,
    agentId: OTHER_AGENT_ID,
    agentName: "support-bot",
    agentDisplayName: "Support Bot",
    name: "support-intake",
    displayName: "Support Intake",
    description: "Sorts incoming support requests.",
    visibility: "public",
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    canPublish: false,
    createdByUserId: CURRENT_USER_ID,
    updatedByUserId: CURRENT_USER_ID,
    createdAt: "2026-06-16T12:00:00.000Z",
    updatedAt: "2026-06-16T12:00:00.000Z",
    instruction: null,
    files: [],
    fileContents: [],
    triggers: [],
  };
}

function agent(id: string, displayName: string): TeamComposeItem {
  return {
    id,
    ownerId: CURRENT_USER_ID,
    displayName,
    description: "Finds and summarizes information",
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_2",
    updatedAt: "2026-06-01T00:00:00Z",
  };
}

function summary(workflow: ZeroWorkflowDetailResponse): ZeroWorkflowSummary {
  return {
    id: workflow.id,
    agentId: workflow.agentId,
    agentName: workflow.agentName,
    agentDisplayName: workflow.agentDisplayName,
    name: workflow.name,
    displayName: workflow.displayName,
    description: workflow.description,
    visibility: workflow.visibility,
    ownerUserId: workflow.ownerUserId,
    ownerUserDisplayName: "Test User",
    ownerUserImageUrl: null,
    createdAt: workflow.createdAt,
    canManage: workflow.canManage,
    canPublish: workflow.canPublish,
  };
}

function mockAgentPageApis(): void {
  context.mocks.data.team([
    agent(AGENT_ID, "Research Bot"),
    agent(OTHER_AGENT_ID, "Support Bot"),
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const displayName =
      params.id === OTHER_AGENT_ID ? "Support Bot" : "Research Bot";
    return respond(200, {
      agentId: params.id,
      ownerId: CURRENT_USER_ID,
      description: "Finds and summarizes information",
      displayName,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
  });
}

function applyWorkflowUpdate(
  workflow: ZeroWorkflowDetailResponse,
  body: ZeroWorkflowUpdateRequest,
): ZeroWorkflowDetailResponse {
  return {
    ...workflow,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.instruction !== undefined
      ? { instruction: body.instruction }
      : {}),
    ...(body.displayName !== undefined
      ? { displayName: body.displayName }
      : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
    ...(body.files !== undefined
      ? {
          files: body.files.map((file) => {
            return { path: file.path, size: file.content.length };
          }),
          fileContents: body.files,
        }
      : {}),
    updatedByUserId: CURRENT_USER_ID,
    updatedAt: "2026-06-21T12:00:00.000Z",
  };
}

function mockWorkflowApis(
  workflows: ZeroWorkflowDetailResponse[],
  onUpdate?: (body: ZeroWorkflowUpdateRequest) => void,
): void {
  const setTriggerEnabled = (
    triggerId: string,
    enabled: boolean,
  ): ZeroWorkflowTriggerSummary | null => {
    for (const workflow of workflows) {
      const triggerIndex = workflow.triggers.findIndex((trigger) => {
        return trigger.id === triggerId;
      });
      if (triggerIndex === -1) {
        continue;
      }
      const currentTrigger = workflow.triggers[triggerIndex];
      if (!currentTrigger) {
        continue;
      }
      const updatedTrigger = { ...currentTrigger, enabled };
      workflow.triggers[triggerIndex] = updatedTrigger;
      return updatedTrigger;
    }
    return null;
  };

  context.mocks.api(
    zeroWorkflowsCollectionContract.list,
    ({ query, respond }) => {
      const visible = query.agentId
        ? workflows.filter((workflow) => {
            return workflow.agentId === query.agentId;
          })
        : workflows;
      return respond(200, visible.map(summary));
    },
  );
  context.mocks.api(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    const detail = workflows.find((workflow) => {
      return workflow.id === params.workflowId;
    });
    if (!detail) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "missing" },
      });
    }
    return respond(200, publicWorkflowDetail(detail));
  });
  context.mocks.api(
    zeroWorkflowTriggersContract.listWorkspace,
    ({ respond }) => {
      return respond(
        200,
        workflows.flatMap((workflow) => {
          return workflow.triggers.map((trigger) => {
            return {
              workflow: summary(workflow),
              trigger: publicWorkflowTrigger(trigger),
            };
          });
        }),
      );
    },
  );
  context.mocks.api(
    zeroWorkflowTriggersContract.revealWebhookSecret,
    ({ params, respond }) => {
      const trigger = workflows
        .flatMap((workflow) => {
          return workflow.triggers;
        })
        .find((item) => {
          return item.id === params.id;
        });
      if (
        trigger &&
        trigger.kind === "event" &&
        trigger.eventType === "webhook-received"
      ) {
        return respond(200, {
          webhookUrl:
            trigger.webhookUrl ??
            "https://api.vm0.test/api/webhooks/workflow-triggers/whk_test",
          webhookSecret: trigger.webhookSecret ?? "webhook-secret",
        });
      }
      return respond(404, {
        error: { code: "NOT_FOUND", message: "missing" },
      });
    },
  );
  context.mocks.api(
    zeroWorkflowTriggersContract.enable,
    ({ params, respond }) => {
      const trigger = setTriggerEnabled(params.id, true);
      if (!trigger) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      return respond(200, trigger);
    },
  );
  context.mocks.api(
    zeroWorkflowTriggersContract.disable,
    ({ params, respond }) => {
      const trigger = setTriggerEnabled(params.id, false);
      if (!trigger) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      return respond(200, trigger);
    },
  );
  context.mocks.api(
    zeroWorkflowsDetailContract.update,
    ({ params, body, respond }) => {
      const index = workflows.findIndex((workflow) => {
        return workflow.id === params.workflowId;
      });
      if (index === -1) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      onUpdate?.(body);
      const workflow = workflows[index];
      workflows[index] = applyWorkflowUpdate(workflow, body);
      return respond(200, workflows[index]);
    },
  );
}

function mockDeleteWorkflow(
  workflows: ZeroWorkflowDetailResponse[],
  onDelete: (workflowId: string) => void | Promise<void>,
): void {
  context.mocks.api(
    zeroWorkflowsDetailContract.delete,
    async ({ params, respond }) => {
      await onDelete(params.workflowId);
      const index = workflows.findIndex((workflow) => {
        return workflow.id === params.workflowId;
      });
      if (index !== -1) {
        workflows.splice(index, 1);
      }
      return respond(204);
    },
  );
}

function mockConnectedTriggerConnectors(): void {
  context.mocks.data.connectors([
    {
      id: "10000000-0000-4000-a000-000000000001",
      type: "slack",
      authMethod: "oauth",
      externalId: "slack-workspace",
      externalUsername: "workspace",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "10000000-0000-4000-a000-000000000002",
      type: "gmail",
      authMethod: "oauth",
      externalId: "gmail-user",
      externalUsername: "user@example.com",
      externalEmail: "user@example.com",
      oauthScopes: ["https://www.googleapis.com/auth/gmail.modify"],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
}

function mockCreateWorkflowTrigger(
  onCreate: (body: ZeroWorkflowTriggerCreateRequest) => void,
): void {
  context.mocks.api(
    zeroWorkflowTriggersContract.create,
    ({ body, respond }) => {
      onCreate(body);
      if (body.kind !== "event") {
        return respond(201, weekdayWorkflowTrigger());
      }
      if (body.eventType === "webhook-received") {
        return respond(201, {
          ...webhookWorkflowTrigger(),
          eventConfig: body.eventConfig ?? webhookWorkflowTrigger().eventConfig,
          webhookSecret: "webhook-secret",
        });
      }
      if (body.eventType === "gmail-label-applied") {
        return respond(201, {
          ...gmailLabelWorkflowTrigger(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "github-label-applied") {
        return respond(201, {
          ...githubLabelWorkflowTrigger(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-calendar-event-created") {
        return respond(201, {
          ...googleCalendarWorkflowTrigger(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-calendar-event-updated") {
        return respond(201, {
          ...googleCalendarUpdatedWorkflowTrigger(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-calendar-event-cancelled") {
        return respond(201, {
          ...googleCalendarCancelledWorkflowTrigger(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-meet-transcript-generated") {
        return respond(201, {
          ...googleMeetTranscriptGeneratedWorkflowTrigger(),
          eventConfig: body.eventConfig,
        });
      }
      return respond(201, {
        ...gmailWorkflowTrigger(),
        eventConfig: body.eventConfig,
      });
    },
  );
}

function mockUpdateWorkflowTrigger(
  onUpdate: (triggerId: string, body: ZeroWorkflowTriggerUpdateRequest) => void,
): void {
  context.mocks.api(
    zeroWorkflowTriggersContract.update,
    ({ params, body, respond }) => {
      onUpdate(params.id, body);
      if ("eventConfig" in body) {
        if (body.eventConfig.provider === "github") {
          return respond(200, {
            ...githubLabelWorkflowTrigger(),
            id: params.id,
            eventConfig: body.eventConfig,
          });
        }
        if (body.eventConfig.event === "label_applied") {
          return respond(200, {
            ...gmailLabelWorkflowTrigger(),
            id: params.id,
            eventConfig: body.eventConfig,
          });
        }
        return respond(200, {
          ...gmailWorkflowTrigger(),
          id: params.id,
          eventConfig: body.eventConfig,
        });
      }
      return respond(200, {
        ...weekdayWorkflowTrigger(),
        id: params.id,
        schedule: body.schedule,
      });
    },
  );
}

function mockRunWorkflowTrigger(onRun: (triggerId: string) => void): void {
  context.mocks.api(zeroWorkflowTriggersContract.run, ({ params, respond }) => {
    onRun(params.id);
    return respond(201, {
      runId: "workflow-trigger-run-now",
      chatThreadId: TRIGGER_RUN_THREAD_ID,
    });
  });
}

function mockDisableWorkflowTrigger(
  onDisable: (triggerId: string) => void,
): void {
  context.mocks.api(
    zeroWorkflowTriggersContract.disable,
    ({ params, respond }) => {
      onDisable(params.id);
      return respond(200, {
        ...weekdayWorkflowTrigger(),
        id: params.id,
        enabled: false,
      });
    },
  );
}

function mockOpenWorkflowChat(onOpen: (workflowId: string) => void): void {
  context.mocks.api(
    zeroWorkflowsDetailContract.chatThread,
    ({ params, respond }) => {
      onOpen(params.workflowId);
      return respond(200, {
        chatThreadId: WORKFLOW_CHAT_THREAD_ID,
        prompt: "/sales-research",
      });
    },
  );
}

type RoleTextMatch = RegExp | string;

function textFor(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function valueMatchesText(value: string, text: RoleTextMatch): boolean {
  return typeof text === "string" ? value === text : text.test(value);
}

function matchesText(element: Element, text: RoleTextMatch): boolean {
  const label = element.getAttribute("aria-label") ?? "";
  return [textFor(element), label].some((value) => {
    return value.length > 0 && valueMatchesText(value, text);
  });
}

function matchLabel(text: RoleTextMatch): string {
  return typeof text === "string" ? text : text.toString();
}

function buttonByText(
  text: RoleTextMatch,
  container: ParentNode = document.body,
): HTMLElement {
  const buttons = queryAllByRoleFast("button", container);
  const button = buttons.find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!button) {
    throw new Error(`${matchLabel(text)} button not found`);
  }
  return button;
}

function menuItemByText(text: RoleTextMatch): HTMLElement {
  const menuItems = queryAllByRoleFast("menuitem");
  const item = menuItems.find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!item) {
    throw new Error(`${matchLabel(text)} menu item not found`);
  }
  return item;
}

// The "Add automation" trigger picker is a dialog split into category tabs on
// the left and trigger cards on the right; a card only mounts once its category
// is active. Select the category, then the card (matched by its leading title,
// since cards also render a description line).
function pickTrigger(category: string, title: RoleTextMatch): void {
  const dialog = screen.getByRole("dialog");
  const tab = queryAllByRoleFast("button", dialog).find((candidate) => {
    return textFor(candidate) === category;
  });
  if (!tab) {
    throw new Error(`${category} trigger category not found`);
  }
  click(tab);
  const card = queryAllByRoleFast("button", dialog).find((candidate) => {
    const text = textFor(candidate);
    return typeof title === "string"
      ? text.startsWith(title)
      : title.test(text);
  });
  if (!card) {
    throw new Error(`${matchLabel(title)} trigger card not found`);
  }
  click(card);
}

function articleByText(text: string): HTMLElement {
  const article = screen
    .getAllByText(text)
    .map((element) => {
      return element.closest("article");
    })
    .find((candidate): candidate is HTMLElement => {
      return candidate instanceof HTMLElement;
    });
  if (!article) {
    throw new Error(`${text} card not found`);
  }
  return article;
}

function linkByAriaLabel(label: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find(
    (candidate): candidate is HTMLAnchorElement => {
      return (
        candidate instanceof HTMLAnchorElement &&
        candidate.getAttribute("aria-label") === label
      );
    },
  );
  if (!link) {
    throw new Error(`${label} link not found`);
  }
  return link;
}

function tabByName(name: string): HTMLElement {
  const tab = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!tab) {
    throw new Error(`${name} filter pill not found`);
  }
  return tab;
}

function selectOptionByLabel(
  label: string,
  option: string | RegExp,
  container: HTMLElement,
): void {
  const control =
    within(container)
      .getAllByLabelText(label)
      .find((element) => {
        return element.getAttribute("role") === "combobox";
      }) ?? within(container).getByLabelText(label);
  click(control);
  click(screen.getByRole("option", { name: option }));
}

async function openCopyDialog(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(buttonByText(/^Copy workflow$/)).toBeInTheDocument();
  });
  click(buttonByText(/^Copy workflow$/));
  return await waitFor(() => {
    return screen.getByRole("dialog");
  });
}

describe("workflows routes", () => {
  it("redirects the workspace workflows index when workflows are disabled", async () => {
    detachedSetupPage({
      context,
      path: "/workflows",
      featureSwitches: { [FeatureSwitchKey.WorkflowAutomation]: false },
    });

    await waitFor(() => {
      expect(pathname()).not.toBe("/workflows");
    });
    expect(
      screen.queryByRole("heading", { name: "Workflows" }),
    ).not.toBeInTheDocument();
  });

  it("redirects the workspace workflow detail when workflows are disabled", async () => {
    detachedSetupPage({
      context,
      path: `/workflows/${SALES_WORKFLOW_ID}/automations`,
      featureSwitches: { [FeatureSwitchKey.WorkflowAutomation]: false },
    });

    await waitFor(() => {
      expect(pathname()).not.toBe(
        `/workflows/${SALES_WORKFLOW_ID}/automations`,
      );
    });
    expect(screen.queryByText("Workflow not found.")).not.toBeInTheDocument();
  });

  it("filters the workspace workflows by automation and visibility", async () => {
    context.mocks.data.userPreferences({ timezone: "UTC" });
    mockAgentPageApis();
    mockChatLifecycle(context);
    mockWorkflowApis([
      salesResearch(),
      opsPlaybook(),
      launchChecklistWorkflow(),
      otherAgentWorkflow(),
    ]);

    detachedSetupPage({
      context,
      path: "/workflows",
      featureSwitches: { [FeatureSwitchKey.WorkflowAutomation]: true },
    });

    await waitFor(() => {
      expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
    });
    expect(search()).toBe("");

    // The default "All" view lists every workspace workflow.
    expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Launch Checklist")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();

    // The automated workflow surfaces its connector pill on the row.
    const salesCard = articleByText("Sales Research");
    expect(within(salesCard).getByText("Schedule")).toBeInTheDocument();

    const supportLink = linkByAriaLabel("Open Support Intake");
    expect(supportLink).toHaveAttribute(
      "href",
      `/workflows/${OTHER_WORKFLOW_ID}/automations`,
    );

    // "Automated" keeps only workflows that have at least one automation.
    click(tabByName("Automated"));
    await waitFor(() => {
      expect(search()).toBe("?filter=automated");
    });
    expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
    expect(screen.queryByText("Ops Playbook")).not.toBeInTheDocument();
    expect(screen.queryByText("Launch Checklist")).not.toBeInTheDocument();
    expect(screen.queryByText("Support Intake")).not.toBeInTheDocument();

    // "Manual" keeps only the manual workflows.
    click(tabByName("Manual"));
    await waitFor(() => {
      expect(search()).toBe("?filter=without");
    });
    expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
    expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Launch Checklist")).toBeInTheDocument();

    // The pills are a single mutually-exclusive group: selecting "Private"
    // replaces the automation selection rather than combining with it.
    click(tabByName("Private"));
    await waitFor(() => {
      expect(search()).toBe("?filter=private");
    });
    expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Launch Checklist")).toBeInTheDocument();
    expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
    expect(screen.queryByText("Support Intake")).not.toBeInTheDocument();

    // "Public" keeps only the public workflows.
    click(tabByName("Public"));
    await waitFor(() => {
      expect(search()).toBe("?filter=public");
    });
    expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();
    expect(screen.queryByText("Ops Playbook")).not.toBeInTheDocument();
    expect(screen.queryByText("Launch Checklist")).not.toBeInTheDocument();

    // Clearing the filter returns to the full list.
    click(tabByName("All"));
    await waitFor(() => {
      expect(search()).toBe("");
    });
    expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();

    expect(CREATE_WORKFLOW_WITH_CHAT_PROMPT).toContain(
      "Help me create a workflow for this agent.",
    );
    expect(CREATE_WORKFLOW_WITH_CHAT_PROMPT).toContain("desired outcome");
    expect(CREATE_WORKFLOW_WITH_CHAT_PROMPT).toContain("automation");
    expect(CREATE_WORKFLOW_WITH_CHAT_PROMPT).not.toContain("Zero workflow");
    expect(CREATE_WORKFLOW_WITH_CHAT_PROMPT).not.toContain("side effects");
    expect(CREATE_WORKFLOW_WITH_CHAT_PROMPT).not.toContain("trigger");

    click(buttonByText(/create in chat/i));
    const dialog = await screen.findByRole("dialog", {
      name: "Create workflow",
    });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Research Bot")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Bot")).toBeInTheDocument();

    click(buttonByText("Research Bot", dialog));
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });
    await expectComposerText(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
  });

  it("redirects the legacy agent workflows tab when workflow automation is enabled", async () => {
    mockAgentPageApis();
    mockWorkflowApis([
      salesResearch(),
      opsPlaybook(),
      launchChecklistWorkflow(),
      otherAgentWorkflow(),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}?tab=workflows`,
      featureSwitches: { [FeatureSwitchKey.WorkflowAutomation]: true },
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}`);
      expect(search()).toBe("");
    });
    expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
    expect(screen.queryByText("Launch Checklist")).not.toBeInTheDocument();
  });
});

describe("workflow detail page", () => {
  it("renders the instruction, files, and triggers", async () => {
    context.mocks.data.userPreferences({ timezone: "UTC" });
    mockWorkflowApis([salesResearch()]);
    mockConnectedTriggerConnectors();

    detachedSetupWorkflowDetailPage(workflowDetailPath("instructions"));

    await waitFor(() => {
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    const breadcrumb = screen.getByLabelText("Breadcrumb");
    const workflowsLink = queryAllByRoleFast("link", breadcrumb).find(
      (link) => {
        return link.textContent?.trim() === "Workflows";
      },
    );
    expect(workflowsLink).toHaveAttribute("href", "/workflows");
    const currentBreadcrumb = within(breadcrumb).getByText("Sales Research");
    expect(currentBreadcrumb).toBeInTheDocument();
    expect(currentBreadcrumb).toHaveClass("font-medium", "text-foreground");
    const workflowFilesButton = screen.getByLabelText("Workflow files");
    expect(workflowFilesButton).toHaveTextContent("instructions");
    click(buttonByText("Automations"));
    await waitFor(() => {
      expect(screen.getByText("Every weekday at 9:00 AM")).toBeInTheDocument();
    });
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/automations`);
    expect(search()).toBe("");
    expect(screen.queryByText("Schedule")).not.toBeInTheDocument();
    expect(screen.getByText("Last")).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Disable Every weekday at 9:00 AM" }),
    ).toBeInTheDocument();
    expect(buttonByText("Run now")).toBeInTheDocument();
    expect(screen.queryByText("Delete automation")).not.toBeInTheDocument();
    click(buttonByText("More actions"));
    expect(menuItemByText("Delete automation")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    click(buttonByText("Settings"));
    await waitFor(() => {
      expect(screen.getAllByText("Visibility").length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByText("Gather CRM context before outreach."),
    ).not.toBeInTheDocument();
    click(buttonByText("Instructions"));
    await waitFor(() => {
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/instructions`);
    expect(search()).toBe("");
    click(screen.getByLabelText("Workflow files"));
    click(menuItemByText(/config\/settings\.json/));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Workflow file content"),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Workflow file content")).toHaveValue(
      '{ "risk": "low", "tone": "direct" }',
    );
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/instructions`);
    expect(search()).toBe("?file=config%2Fsettings.json");
  });

  it("ignores stale workflow instruction drafts without edit permission", async () => {
    const workflow = {
      ...salesResearch(),
      canManage: false,
      canPublish: false,
    };
    context.store.set(setWorkflowFileDraft$, {
      workflowId: SALES_WORKFLOW_ID,
      filePath: null,
      sourceContent: "Gather CRM context before outreach.",
      content: "Unsaved local workflow draft.",
    });
    mockWorkflowApis([workflow]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("instructions"));

    await waitFor(() => {
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Unsaved local workflow draft."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();
  });

  it("disables publishing when the workflow owner lacks agent write permission", async () => {
    const workflow = {
      ...opsPlaybook(),
      canManage: true,
      canPublish: false,
    };
    mockWorkflowApis([workflow]);

    detachedSetupPage({
      context,
      path: `/workflows/${OPS_WORKFLOW_ID}/info`,
      featureSwitches: { [FeatureSwitchKey.WorkflowAutomation]: true },
    });

    const publishSwitch = await screen.findByRole("switch", {
      name: "Make workflow public",
    });
    expect(publishSwitch).toBeDisabled();
    expect(
      screen.getByText(
        "Publishing a workflow under an agent you do not own requires org admin permissions.",
      ),
    ).toBeInTheDocument();
  });

  it("opens the shared workflow chat thread with the workflow slash command", async () => {
    const openedWorkflowIds: string[] = [];
    mockChatLifecycle(context, { threadId: WORKFLOW_CHAT_THREAD_ID });
    mockWorkflowApis([salesResearch()]);
    mockOpenWorkflowChat((workflowId) => {
      openedWorkflowIds.push(workflowId);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("instructions"));

    await waitFor(() => {
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });

    click(buttonByText("Refine with Research Bot"));

    await waitFor(() => {
      expect(openedWorkflowIds).toStrictEqual([SALES_WORKFLOW_ID]);
    });
    expect(pathname()).toBe(`/chats/${WORKFLOW_CHAT_THREAD_ID}`);
    expect(search()).toBe("");
    await expectComposerText("/sales-research");
  });

  it("orders workflow info sections without audit metadata", async () => {
    mockWorkflowApis([salesResearch()]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"));

    await waitFor(() => {
      expect(screen.getAllByText("Visibility").length).toBeGreaterThan(0);
    });

    const pageText = textFor(document.body);
    expect(pageText).not.toContain("Created by");
    expect(pageText).not.toContain("Last updated by");
    expect(pageText).not.toContain("Jun 17, 2026");
    expect(pageText).not.toContain("Jun 20, 2026");
    expect(pageText.indexOf("Slug")).toBeLessThan(
      pageText.indexOf("Visibility"),
    );
    expect(pageText.indexOf("Visibility")).toBeLessThan(
      pageText.indexOf("Copy workflow"),
    );
    expect(pageText.indexOf("Copy workflow")).toBeLessThan(
      pageText.indexOf("Delete workflow"),
    );
  });

  it("copies a workflow to another agent from the info tab", async () => {
    const workflows = [salesResearch()];
    const copiedWorkflow: ZeroWorkflowDetailResponse = {
      ...salesResearch(),
      id: COPIED_WORKFLOW_ID,
      agentId: OTHER_AGENT_ID,
      agentName: "support-bot",
      agentDisplayName: "Support Bot",
      visibility: "private",
      triggers: [],
    };
    const copyRequests: {
      readonly workflowId: string;
      readonly toAgentId: string;
    }[] = [];
    const disabledTriggerIds: string[] = [];
    const deletedWorkflowIds: string[] = [];
    mockAgentPageApis();
    mockWorkflowApis(workflows);
    mockDisableWorkflowTrigger((triggerId) => {
      disabledTriggerIds.push(triggerId);
    });
    mockDeleteWorkflow(workflows, (workflowId) => {
      deletedWorkflowIds.push(workflowId);
    });
    context.mocks.api(
      zeroWorkflowsDetailContract.copy,
      ({ params, body, respond }) => {
        copyRequests.push({
          workflowId: params.workflowId,
          toAgentId: body.toAgentId,
        });
        workflows.push(copiedWorkflow);
        return respond(201, summary(copiedWorkflow));
      },
    );

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"));

    const dialog = await openCopyDialog();
    expect(
      within(dialog).getByText(
        "Copy this workflow to another agent as a new private workflow.",
      ),
    ).toBeInTheDocument();

    selectOptionByLabel("Copy to", "Support Bot", dialog);
    click(buttonByText(/^Copy workflow$/, dialog));

    await waitFor(() => {
      expect(copyRequests).toStrictEqual([
        { workflowId: SALES_WORKFLOW_ID, toAgentId: OTHER_AGENT_ID },
      ]);
    });
    // Copy-only never touches the source workflow or its automations.
    expect(disabledTriggerIds).toStrictEqual([]);
    expect(deletedWorkflowIds).toStrictEqual([]);
    // Stays on the source page and offers a link to the fresh copy.
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/info`);
    await expect(
      screen.findByText("Copied to Support Bot"),
    ).resolves.toBeInTheDocument();

    click(buttonByText("View"));
    await waitFor(() => {
      expect(pathname()).toBe(`/workflows/${COPIED_WORKFLOW_ID}/automations`);
    });
  });

  it("keeps the copy dialog open when copying fails", async () => {
    mockAgentPageApis();
    mockWorkflowApis([salesResearch()]);
    context.mocks.api(zeroWorkflowsDetailContract.copy, ({ respond }) => {
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: "Failed to copy workflow",
        },
      });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"));

    const dialog = await openCopyDialog();
    selectOptionByLabel("Copy to", "Support Bot", dialog);
    click(buttonByText(/^Copy workflow$/, dialog));

    await expect(
      screen.findByText("Failed to copy workflow"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText(/Copied to/)).not.toBeInTheDocument();
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/info`);
  });

  it("moves a workflow by removing the original after copying", async () => {
    const workflows = [salesResearch()];
    const copiedWorkflow: ZeroWorkflowDetailResponse = {
      ...salesResearch(),
      id: COPIED_WORKFLOW_ID,
      agentId: OTHER_AGENT_ID,
      agentName: "support-bot",
      agentDisplayName: "Support Bot",
      visibility: "private",
      triggers: [],
    };
    const copyRequests: {
      readonly workflowId: string;
      readonly toAgentId: string;
    }[] = [];
    const disabledTriggerIds: string[] = [];
    const deletedWorkflowIds: string[] = [];
    mockAgentPageApis();
    mockWorkflowApis(workflows);
    mockDisableWorkflowTrigger((triggerId) => {
      disabledTriggerIds.push(triggerId);
    });
    mockDeleteWorkflow(workflows, (workflowId) => {
      deletedWorkflowIds.push(workflowId);
    });
    context.mocks.api(
      zeroWorkflowsDetailContract.copy,
      ({ params, body, respond }) => {
        copyRequests.push({
          workflowId: params.workflowId,
          toAgentId: body.toAgentId,
        });
        workflows.push(copiedWorkflow);
        return respond(201, summary(copiedWorkflow));
      },
    );

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"));

    const dialog = await openCopyDialog();
    selectOptionByLabel("Copy to", "Support Bot", dialog);

    // Opting to remove the original reveals the destructive alert and
    // relabels the primary action.
    click(within(dialog).getByRole("checkbox"));
    expect(
      within(dialog).getByText("This deletes the original"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "1 automation is paused on Research Bot and this workflow is deleted.",
      ),
    ).toBeInTheDocument();

    click(buttonByText(/^Copy and remove$/, dialog));

    await waitFor(() => {
      expect(copyRequests).toStrictEqual([
        { workflowId: SALES_WORKFLOW_ID, toAgentId: OTHER_AGENT_ID },
      ]);
    });
    await waitFor(() => {
      expect(disabledTriggerIds).toStrictEqual([
        "workflow-trigger-weekday-brief",
      ]);
    });
    await waitFor(() => {
      expect(deletedWorkflowIds).toStrictEqual([SALES_WORKFLOW_ID]);
    });
    // Navigates to the copy because the source page no longer exists.
    await waitFor(() => {
      expect(pathname()).toBe(`/workflows/${COPIED_WORKFLOW_ID}/automations`);
    });
    await expect(
      screen.findByText("Moved to Support Bot"),
    ).resolves.toBeInTheDocument();
    expect(
      workflows.some((workflow) => {
        return workflow.id === SALES_WORKFLOW_ID;
      }),
    ).toBeFalsy();
  });

  it("prefills and updates workflow metadata from the info tab", async () => {
    const updateBodies: ZeroWorkflowUpdateRequest[] = [];
    mockWorkflowApis([salesResearch()], (body) => {
      updateBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"));

    const form = await screen.findByRole("form", {
      name: "Workflow metadata",
    });
    expect(within(form).getByLabelText("Name")).toHaveValue("Sales Research");
    expect(within(form).getByLabelText("Slug")).toHaveValue("sales-research");
    expect(within(form).getByLabelText("Description")).toHaveValue(
      "Collects account context before outreach.",
    );
    expect(
      within(form).getByText(/Lowercase letters, numbers, and - only/),
    ).toBeInTheDocument();
    expect(
      within(form).getByText(/Tell the agent when to use this workflow/),
    ).toBeInTheDocument();

    await fill(within(form).getByLabelText("Name"), "Account Brief");
    await fill(within(form).getByLabelText("Slug"), "account-brief");
    await fill(
      within(form).getByLabelText("Description"),
      "Use when an account needs a fresh research brief.",
    );
    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });
    click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        name: "account-brief",
        displayName: "Account Brief",
        description: "Use when an account needs a fresh research brief.",
      });
    });
  });

  it("ignores stale workflow metadata edits without edit permission", async () => {
    const workflow = {
      ...salesResearch(),
      canManage: false,
      canPublish: false,
    };
    context.store.set(patchWorkflowMetadataForm$, {
      workflowId: SALES_WORKFLOW_ID,
      patch: { displayName: "Unsaved Account Brief" },
    });
    mockWorkflowApis([workflow]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"));

    const form = await screen.findByRole("form", {
      name: "Workflow metadata",
    });
    expect(within(form).getByLabelText("Name")).toHaveValue("Sales Research");
    expect(
      screen.queryByText("You have unsaved changes"),
    ).not.toBeInTheDocument();
  });

  it("derives the active tab from workflow detail search params", async () => {
    context.mocks.data.userPreferences({ timezone: "UTC" });
    mockWorkflowApis([salesResearch()]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Every weekday at 9:00 AM")).toBeInTheDocument();
    });
    click(buttonByText("Settings"));

    await waitFor(() => {
      expect(screen.getAllByText("Visibility").length).toBeGreaterThan(0);
    });
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/info`);
    expect(search()).toBe("");
    click(buttonByText("Instructions"));
    await waitFor(() => {
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/instructions`);
    expect(search()).toBe("");
  });

  it("renders Gmail new message trigger match summaries", async () => {
    const workflow = {
      ...salesResearch(),
      triggers: [...workflowTriggers(), gmailWorkflowTrigger()],
    };
    mockWorkflowApis([workflow]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(
        0,
      );
    });

    await waitFor(() => {
      expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(
        0,
      );
    });
    expect(screen.getByText(/from contains "@acme.com"/)).toBeInTheDocument();
    expect(
      screen.getByText(/subject does not contain "newsletter"/),
    ).toBeInTheDocument();
  });

  it("runs a trigger immediately and navigates to the bound chat thread", async () => {
    const runTriggerIds: string[] = [];
    mockWorkflowApis([salesResearch()]);
    mockChatLifecycle(context, { threadId: TRIGGER_RUN_THREAD_ID });
    mockRunWorkflowTrigger((triggerId) => {
      runTriggerIds.push(triggerId);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Run now")).toBeInTheDocument();
    });
    click(buttonByText("Run now"));

    await waitFor(() => {
      expect(runTriggerIds).toStrictEqual(["workflow-trigger-weekday-brief"]);
    });
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${TRIGGER_RUN_THREAD_ID}`);
    });
    expect(search()).toBe("");
  });

  it("creates a Gmail new message trigger with text match rules", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Email", /^Gmail new message/);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add Gmail automation",
    });
    await fill(
      within(createTriggerForm).getByLabelText("From contains"),
      "@acme.com",
    );
    await fill(
      within(createTriggerForm).getByLabelText("Subject does not contain"),
      "newsletter",
    );
    fireEvent.submit(createTriggerForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            from: { contains: "@acme.com" },
            subject: { doesNotContain: "newsletter" },
          },
        },
      });
    });
  });

  it("creates a Gmail label applied trigger with a label name", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Email", /^Gmail label applied/);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add Gmail label automation",
    });
    await fill(
      within(createTriggerForm).getByLabelText("Label name"),
      "Support",
    );
    fireEvent.submit(createTriggerForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Support",
        },
      });
    });
  });

  it("creates a Google Calendar event-updated trigger", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.WorkflowAutomation]: true,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Calendar", /^Google Calendar event updated/);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add Google Calendar automation",
    });
    await fill(
      within(createTriggerForm).getByLabelText("Calendar ID"),
      "team@example.com",
    );
    fireEvent.submit(createTriggerForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "google-calendar-event-updated",
        eventConfig: {
          provider: "google-calendar",
          event: "event_updated",
          calendarId: "team@example.com",
        },
      });
    });
  });

  it("creates a Google Calendar event-cancelled trigger", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.WorkflowAutomation]: true,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Calendar", /^Google Calendar event cancelled/);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add Google Calendar automation",
    });
    await fill(
      within(createTriggerForm).getByLabelText("Calendar ID"),
      "team@example.com",
    );
    fireEvent.submit(createTriggerForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "google-calendar-event-cancelled",
        eventConfig: {
          provider: "google-calendar",
          event: "event_cancelled",
          calendarId: "team@example.com",
        },
      });
    });
  });

  it("creates a Google Meet transcript-generated trigger", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.WorkflowAutomation]: true,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Calendar", /^Google Meet transcript ready/);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add Google Meet transcript automation",
    });
    fireEvent.submit(createTriggerForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "google-meet-transcript-generated",
        eventConfig: {
          provider: "google-meet",
          event: "transcript_generated",
          scope: { type: "organizer_user" },
        },
      });
    });
  });

  it("creates a webhook trigger and shows one-time signing details", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.WorkflowAutomation]: true,
      [FeatureSwitchKey.WorkflowWebhookTriggers]: true,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Integrations", /^Webhook/);
    await waitFor(() => {
      expect(buttonByText("Create webhook")).toBeInTheDocument();
    });
    click(buttonByText("Create webhook"));

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "webhook-received",
        eventConfig: {
          provider: "webhook",
          event: "received",
          auth: { mode: "hmac-sha256" },
        },
      });
    });
    const webhookUrlField = await screen.findByDisplayValue(
      webhookWorkflowTrigger().webhookUrl ?? "",
    );
    expect(webhookUrlField).toBeInTheDocument();
    expect(webhookUrlField).toHaveValue(
      webhookWorkflowTrigger().webhookUrl ?? "",
    );
    expect(webhookUrlField).toHaveClass("min-w-0");
    expect(screen.getByDisplayValue("webhook-secret")).toHaveValue(
      "webhook-secret",
    );
    const signedCurlExample = screen
      .getByText(/X-VM0-Signature/)
      .closest("pre");
    expect(signedCurlExample).toBeInTheDocument();
    expect(signedCurlExample).toHaveClass("whitespace-pre-wrap", "break-all");
  });

  it("reveals an existing webhook secret on demand", async () => {
    const workflow = {
      ...salesResearch(),
      triggers: [webhookWorkflowTrigger()],
    };
    mockWorkflowApis([workflow]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.WorkflowAutomation]: true,
      [FeatureSwitchKey.WorkflowWebhookTriggers]: true,
    });

    await waitFor(() => {
      expect(screen.getByText("Webhook URL hidden")).toBeInTheDocument();
    });
    expect(
      screen.queryByDisplayValue(webhookWorkflowTrigger().webhookUrl ?? ""),
    ).not.toBeInTheDocument();
    click(buttonByText("More actions"));
    click(menuItemByText("View webhook secret"));
    click(await screen.findByText("Reveal secret"));

    const webhookUrlField = await screen.findByDisplayValue(
      webhookWorkflowTrigger().webhookUrl ?? "",
    );
    expect(webhookUrlField).toBeInTheDocument();
    expect(screen.getByDisplayValue("webhook-secret")).toHaveValue(
      "webhook-secret",
    );
  });

  it("hides webhook creation when the webhook trigger switch is disabled", async () => {
    mockWorkflowApis([salesResearch()]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.WorkflowAutomation]: true,
      [FeatureSwitchKey.WorkflowWebhookTriggers]: false,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    const dialog = screen.getByRole("dialog");
    const openCategory = (category: string): void => {
      const tab = queryAllByRoleFast("button", dialog).find((candidate) => {
        return textFor(candidate) === category;
      });
      if (!tab) {
        throw new Error(`${category} trigger category not found`);
      }
      click(tab);
    };

    // The Email category still lists Gmail triggers — the picker works.
    openCategory("Email");
    expect(
      queryAllByRoleFast("button", dialog).some((candidate) => {
        return textFor(candidate).startsWith("Gmail new message");
      }),
    ).toBeTruthy();

    // The Integrations category offers GitHub but hides Webhook while its
    // feature switch is off.
    openCategory("Integrations");
    const integrationCards = queryAllByRoleFast("button", dialog);
    expect(
      integrationCards.some((candidate) => {
        return textFor(candidate).startsWith("GitHub label applied");
      }),
    ).toBeTruthy();
    expect(
      integrationCards.some((candidate) => {
        return textFor(candidate).startsWith("Webhook");
      }),
    ).toBeFalsy();
  });

  it("creates a cron schedule trigger from the preferred time zone", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Schedule", /^Scheduled time/u);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add schedule automation",
    });
    expect(
      within(createTriggerForm).getByText("Time (Asia/Shanghai)"),
    ).toBeInTheDocument();
    expect(within(createTriggerForm).queryByText(/Saved as/u)).toBeNull();
    click(buttonByText("Add schedule", createTriggerForm));

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        schedule: {
          type: "cron",
          cronExpression: "0 1 * * *",
          timezone: "UTC",
        },
      });
    });
  });

  it("creates an interval trigger from the trigger menu", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Schedule", /^Interval/u);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add interval automation",
    });
    selectOptionByLabel("Every", "30 minutes", createTriggerForm);
    click(buttonByText("Add interval", createTriggerForm));

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        schedule: {
          type: "loop",
          intervalSeconds: 1800,
        },
      });
    });
  });

  it("creates a one-time trigger from the trigger menu", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickTrigger("Schedule", /^One-time run/u);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add one-time automation",
    });
    fireEvent.change(within(createTriggerForm).getByLabelText("Run at"), {
      target: { value: "2026-07-01T10:30" },
    });
    click(buttonByText("Add one-time run", createTriggerForm));

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        schedule: {
          type: "once",
          atTime: new Date("2026-07-01T10:30").toISOString(),
          timezone: "UTC",
        },
      });
    });
  });

  it("updates a cron schedule trigger from the preferred time zone", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
    const workflow = {
      ...salesResearch(),
      triggers: [
        {
          ...weekdayWorkflowTrigger(),
          schedule: {
            type: "cron",
            cronExpression: "0 1 * * 1-5",
            timezone: "UTC",
          },
        } satisfies WorkflowScheduleTriggerSummary,
      ],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowTrigger((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Every weekday at 9:00 AM")).toBeInTheDocument();
    });

    click(buttonByText("Edit automation"));

    const updateTriggerForm = screen.getByRole("form", {
      name: "Update schedule automation",
    });
    selectOptionByLabel("Hour", "16", updateTriggerForm);
    selectOptionByLabel("Minute", "45", updateTriggerForm);
    click(buttonByText("Save schedule", updateTriggerForm));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: "workflow-trigger-weekday-brief",
        body: {
          schedule: {
            type: "cron",
            cronExpression: "45 8 * * 1-5",
            timezone: "UTC",
          },
        },
      });
    });
  });

  it("updates a loop schedule trigger from the edit dialog", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      triggers: [
        {
          ...weekdayWorkflowTrigger(),
          schedule: {
            type: "loop",
            intervalSeconds: 3600,
          },
          scheduleSummary: "Every 3600s",
        } satisfies WorkflowScheduleTriggerSummary,
      ],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowTrigger((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Every 1 hour")).toBeInTheDocument();
    });

    click(buttonByText("Edit automation"));

    const updateTriggerForm = screen.getByRole("form", {
      name: "Update schedule automation",
    });
    selectOptionByLabel("Every", "30 minutes", updateTriggerForm);
    fireEvent.submit(updateTriggerForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: "workflow-trigger-weekday-brief",
        body: {
          schedule: {
            type: "loop",
            intervalSeconds: 1800,
          },
        },
      });
    });
  });

  it("updates a Gmail new message trigger with text match rules", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      triggers: [
        {
          ...gmailWorkflowTrigger(),
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: {
              from: { containsAny: ["@vip.example"] },
              subject: { doesNotContain: "newsletter" },
            },
          },
        } satisfies WorkflowGmailNewMessageTriggerSummary,
      ],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowTrigger((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(
        0,
      );
    });

    click(buttonByText("Edit automation"));

    const updateTriggerForm = screen.getByRole("form", {
      name: "Update Gmail new message automation",
    });
    await fill(
      within(updateTriggerForm).getByLabelText("From contains"),
      "@acme.com",
    );
    await fill(
      within(updateTriggerForm).getByLabelText("Body contains"),
      "invoice",
    );
    fireEvent.submit(updateTriggerForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: GMAIL_TRIGGER_ID,
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: {
              from: {
                contains: "@acme.com",
                containsAny: ["@vip.example"],
              },
              subject: { doesNotContain: "newsletter" },
              body: { contains: "invoice" },
            },
          },
        },
      });
    });
  });

  it("updates a Gmail label applied trigger with a label name", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      triggers: [gmailLabelWorkflowTrigger()],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowTrigger((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Gmail label applied")).toBeInTheDocument();
    });

    click(buttonByText("Edit automation"));

    const updateTriggerForm = screen.getByRole("form", {
      name: "Update Gmail label automation",
    });
    await fill(
      within(updateTriggerForm).getByLabelText("Label name"),
      "Escalated",
    );
    fireEvent.submit(updateTriggerForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: GMAIL_LABEL_TRIGGER_ID,
        body: {
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Escalated",
          },
        },
      });
    });
  });

  it("warns when the workflow is shadowed by the runtime slash priority", async () => {
    const workflow = {
      ...salesResearch(),
      shadowedBy: {
        id: OPS_WORKFLOW_ID,
        name: "sales-research",
        displayName: "Private Sales Research",
      },
    };
    mockWorkflowApis([workflow]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("instructions"));

    await waitFor(() => {
      expect(screen.getByText(/currently resolves to/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Private Sales Research")).toBeInTheDocument();
  });

  it("deletes the selected supplementary file through the workflow update endpoint", async () => {
    const updateBodies: ZeroWorkflowUpdateRequest[] = [];
    mockWorkflowApis([salesResearch()], (body) => {
      updateBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("instructions"));

    await waitFor(() => {
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    click(screen.getByLabelText("Workflow files"));
    click(menuItemByText(/config\/settings\.json/));
    click(screen.getByLabelText("Workflow files"));
    click(screen.getByLabelText("Delete config/settings.json"));

    await waitFor(() => {
      expect(updateBodies.at(-1)?.files).toStrictEqual([
        {
          path: "examples/prompt.md",
          content: "# Prompt example\n\nAsk for market segment and urgency.\n",
        },
      ]);
    });
  });

  it("uploads supplementary files through the workflow update endpoint", async () => {
    const updateBodies: ZeroWorkflowUpdateRequest[] = [];
    mockWorkflowApis([salesResearch()], (body) => {
      updateBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("instructions"));

    await waitFor(() => {
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Workflow files"));
    const input = screen.getByLabelText("Upload workflow files");
    fireEvent.change(input, {
      target: {
        files: [new File(["new notes"], "notes.md", { type: "text/markdown" })],
      },
    });

    await waitFor(() => {
      expect(updateBodies.at(-1)?.files).toContainEqual({
        path: "notes.md",
        content: "new notes",
      });
    });
    expect(updateBodies.at(-1)?.files).toContainEqual({
      path: "config/settings.json",
      content: '{ "risk": "low", "tone": "direct" }',
    });
  });
});
