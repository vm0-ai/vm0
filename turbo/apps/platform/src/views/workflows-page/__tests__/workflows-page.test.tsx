import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowVisibilityContract,
  zeroWorkflowAutomationsContract,
  type ZeroWorkflowAutomationCreateRequest,
  type ZeroWorkflowAutomationUpdateRequest,
  type ZeroWorkflowUpdateRequest,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowAutomationSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
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
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../../zero-page/workflow-automations-page.tsx";
import {
  createDefaultMockGithubIntegration,
  setMockGithubIntegration,
} from "../../../mocks/handlers/api-integrations-github.ts";

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
const GMAIL_AUTOMATION_ID = "workflow-automation-gmail-new-message";
const GMAIL_LABEL_AUTOMATION_ID = "workflow-automation-gmail-label-applied";
const GITHUB_LABEL_AUTOMATION_ID = "workflow-automation-github-label-applied";
const GOOGLE_CALENDAR_AUTOMATION_ID =
  "workflow-automation-google-calendar-created";
const GOOGLE_MEET_AUTOMATION_ID = "workflow-automation-google-meet-transcript";
const WORKFLOW_CHAT_THREAD_ID = "00000000-0000-4000-a000-000000000300";
const AUTOMATION_RUN_THREAD_ID = "00000000-0000-4000-a000-000000000301";

type WorkflowDetailTestTab = "automations" | "instructions" | "info";

afterEach(() => {
  toast.dismiss();
});

function workflowDetailPath(tab: WorkflowDetailTestTab): string {
  return `/workflows/${SALES_WORKFLOW_ID}/${tab}`;
}

function connectorIcon(connectorRef: string) {
  return {
    url: `https://icons.example.test/${connectorRef}.svg`,
    invertInDarkMode: false,
  };
}

function detachedSetupWorkflowDetailPage(
  path: string,
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
  billingTier = "team",
  billingCapabilities: Partial<BillingStatusResponse> = {},
) {
  mockBillingTier(billingTier, billingCapabilities);
  detachedSetupPage({
    context,
    path,
    featureSwitches: {
      ...featureSwitches,
    },
  });
}

function billingStatus(
  tier: string,
  capabilities: Partial<BillingStatusResponse> = {},
): BillingStatusResponse {
  return {
    tier,
    credits: 20_000,
    onboardingPaymentPending: false,
    subscriptionStatus: tier === "team" ? "active" : null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: tier === "pro" || tier === "team",
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
    ...capabilities,
  };
}

function mockBillingTier(
  tier: string,
  capabilities: Partial<BillingStatusResponse> = {},
): void {
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(tier, capabilities));
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

type WorkflowScheduleAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "schedule" }
>;
type WorkflowGmailNewMessageAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "gmail-new-message" }
>;
type WorkflowWebhookAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "webhook-received" }
>;
type WorkflowGmailLabelAppliedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "gmail-label-applied" }
>;
type WorkflowGithubLabelAppliedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "github-label-applied" }
>;
type WorkflowGoogleCalendarEventCreatedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "google-calendar-event-created" }
>;
type WorkflowGoogleCalendarEventUpdatedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "google-calendar-event-updated" }
>;
type WorkflowGoogleCalendarEventCancelledAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "google-calendar-event-cancelled" }
>;
type WorkflowGoogleMeetTranscriptGeneratedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "google-meet-transcript-generated" }
>;
type WorkflowNotionChildPageCreatedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "notion-child-page-created" }
>;
type WorkflowNotionDatabaseItemCreatedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "notion-database-item-created" }
>;
type WorkflowNotionPageContentUpdatedAutomationSummary = Extract<
  ZeroWorkflowAutomationSummary,
  { kind: "event"; eventType: "notion-page-content-updated" }
>;

function workflowAutomations(): ZeroWorkflowAutomationSummary[] {
  return [weekdayWorkflowAutomation()];
}

function weekdayWorkflowAutomation(): WorkflowScheduleAutomationSummary {
  return {
    id: "workflow-automation-weekday-brief",
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

function gmailWorkflowAutomation(): WorkflowGmailNewMessageAutomationSummary {
  return {
    id: GMAIL_AUTOMATION_ID,
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

function gmailLabelWorkflowAutomation(): WorkflowGmailLabelAppliedAutomationSummary {
  return {
    id: GMAIL_LABEL_AUTOMATION_ID,
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

function githubLabelWorkflowAutomation(): WorkflowGithubLabelAppliedAutomationSummary {
  return {
    id: GITHUB_LABEL_AUTOMATION_ID,
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

function googleCalendarWorkflowAutomation(): WorkflowGoogleCalendarEventCreatedAutomationSummary {
  return {
    id: GOOGLE_CALENDAR_AUTOMATION_ID,
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

function googleCalendarUpdatedWorkflowAutomation(): WorkflowGoogleCalendarEventUpdatedAutomationSummary {
  return {
    id: "workflow-automation-google-calendar-updated",
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

function googleCalendarCancelledWorkflowAutomation(): WorkflowGoogleCalendarEventCancelledAutomationSummary {
  return {
    id: "workflow-automation-google-calendar-cancelled",
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

function googleMeetTranscriptGeneratedWorkflowAutomation(): WorkflowGoogleMeetTranscriptGeneratedAutomationSummary {
  return {
    id: GOOGLE_MEET_AUTOMATION_ID,
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

function notionChildPageWorkflowAutomation(): WorkflowNotionChildPageCreatedAutomationSummary {
  return {
    id: "workflow-automation-notion-child-page",
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      connectorId: "00000000-0000-4000-a000-000000000410",
      parentPage: {
        id: "11111111-1111-4111-8111-111111111111",
        url: "https://www.notion.so/Roadmap-11111111111141118111111111111111",
        title: "Roadmap",
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_notion_child_page",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function notionDatabaseItemWorkflowAutomation(): WorkflowNotionDatabaseItemCreatedAutomationSummary {
  return {
    id: "workflow-automation-notion-database-item",
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      connectorId: "00000000-0000-4000-a000-000000000410",
      dataSource: {
        id: "22222222-2222-4222-8222-222222222222",
        url: "https://www.notion.so/Bug-Bash-22222222222242228222222222222222",
        title: "Bug Bash",
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_notion_database_item",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function notionPageContentUpdatedWorkflowAutomation(): WorkflowNotionPageContentUpdatedAutomationSummary {
  return {
    id: "workflow-automation-notion-page-content-updated",
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      connectorId: "00000000-0000-4000-a000-000000000410",
      scope: {
        type: "page",
        page: {
          id: "33333333-3333-4333-8333-333333333333",
          url: "https://www.notion.so/Release-plan-33333333333343338333333333333333",
          title: "Release plan",
        },
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_notion_page_content_updated",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function webhookWorkflowAutomation(): WorkflowWebhookAutomationSummary {
  return {
    id: "workflow-automation-webhook",
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
    webhookUrl:
      "https://api.vm0.test/api/webhooks/workflow-automations/whk_test",
    secretLastFour: "abcd",
    lastReceivedAt: null,
  };
}

function publicWorkflowAutomation(
  automation: ZeroWorkflowAutomationSummary,
): ZeroWorkflowAutomationSummary {
  if (
    automation.kind !== "event" ||
    automation.eventType !== "webhook-received"
  ) {
    return automation;
  }
  const {
    webhookUrl: _webhookUrl,
    webhookSecret: _webhookSecret,
    ...rest
  } = automation;
  return rest;
}

function publicWorkflowDetail(
  detail: ZeroWorkflowDetailResponse,
): ZeroWorkflowDetailResponse {
  return {
    ...detail,
    automations: detail.automations.map(publicWorkflowAutomation),
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
    automations: workflowAutomations(),
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
    automations: [],
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
    automations: [],
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
    automations: [],
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
  const setAutomationEnabled = (
    automationId: string,
    enabled: boolean,
  ): ZeroWorkflowAutomationSummary | null => {
    for (const workflow of workflows) {
      const automationIndex = workflow.automations.findIndex((automation) => {
        return automation.id === automationId;
      });
      if (automationIndex === -1) {
        continue;
      }
      const currentAutomation = workflow.automations[automationIndex];
      if (!currentAutomation) {
        continue;
      }
      const updatedAutomation = { ...currentAutomation, enabled };
      workflow.automations[automationIndex] = updatedAutomation;
      return updatedAutomation;
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
    const publicDetail = publicWorkflowDetail(detail);
    return respond(200, publicDetail);
  });
  context.mocks.api(
    zeroWorkflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(
        200,
        workflows.flatMap((workflow) => {
          return workflow.automations.map((automation) => {
            return {
              workflow: summary(workflow),
              automation: publicWorkflowAutomation(automation),
            };
          });
        }) as never,
      );
    },
  );
  context.mocks.api(
    zeroWorkflowAutomationsContract.revealWebhookSecret,
    ({ params, respond }) => {
      const automation = workflows
        .flatMap((workflow) => {
          return workflow.automations;
        })
        .find((item) => {
          return item.id === params.id;
        });
      if (
        automation &&
        automation.kind === "event" &&
        automation.eventType === "webhook-received"
      ) {
        return respond(200, {
          webhookUrl:
            automation.webhookUrl ??
            "https://api.vm0.test/api/webhooks/workflow-automations/whk_test",
          webhookSecret: automation.webhookSecret ?? "webhook-secret",
        });
      }
      return respond(404, {
        error: { code: "NOT_FOUND", message: "missing" },
      });
    },
  );
  context.mocks.api(
    zeroWorkflowAutomationsContract.enable,
    ({ params, respond }) => {
      const automation = setAutomationEnabled(params.id, true);
      if (!automation) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      return respond(200, automation);
    },
  );
  context.mocks.api(
    zeroWorkflowAutomationsContract.disable,
    ({ params, respond }) => {
      const automation = setAutomationEnabled(params.id, false);
      if (!automation) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      return respond(200, automation);
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

function mockConnectedAutomationConnectors(): void {
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

function mockCreateWorkflowAutomation(
  onCreate: (body: ZeroWorkflowAutomationCreateRequest) => void,
): void {
  context.mocks.api(
    zeroWorkflowAutomationsContract.create,
    ({ body, respond }) => {
      onCreate(body);
      if (body.kind !== "event") {
        return respond(201, weekdayWorkflowAutomation());
      }
      if (body.eventType === "webhook-received") {
        return respond(201, {
          ...webhookWorkflowAutomation(),
          eventConfig:
            body.eventConfig ?? webhookWorkflowAutomation().eventConfig,
          webhookSecret: "webhook-secret",
        });
      }
      if (body.eventType === "gmail-label-applied") {
        return respond(201, {
          ...gmailLabelWorkflowAutomation(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "github-label-applied") {
        return respond(201, {
          ...githubLabelWorkflowAutomation(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "github-workflow-run-completed") {
        return respond(201, {
          ...githubLabelWorkflowAutomation(),
          eventType: "github-workflow-run-completed",
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-calendar-event-created") {
        return respond(201, {
          ...googleCalendarWorkflowAutomation(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-calendar-event-updated") {
        return respond(201, {
          ...googleCalendarUpdatedWorkflowAutomation(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-calendar-event-cancelled") {
        return respond(201, {
          ...googleCalendarCancelledWorkflowAutomation(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "google-meet-transcript-generated") {
        return respond(201, {
          ...googleMeetTranscriptGeneratedWorkflowAutomation(),
          eventConfig: body.eventConfig,
        });
      }
      if (body.eventType === "notion-child-page-created") {
        return respond(201, {
          ...notionChildPageWorkflowAutomation(),
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            connectorId: "00000000-0000-4000-a000-000000000410",
            parentPage: {
              id: "11111111-1111-4111-8111-111111111111",
              url: body.eventConfig.parentPageUrl,
              title: "Roadmap",
              rawUrl: body.eventConfig.parentPageUrl,
            },
          },
        });
      }
      if (body.eventType === "notion-database-item-created") {
        return respond(201, {
          ...notionDatabaseItemWorkflowAutomation(),
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            connectorId: "00000000-0000-4000-a000-000000000410",
            dataSource: {
              id: "22222222-2222-4222-8222-222222222222",
              url: body.eventConfig.databaseUrl,
              title: "Bug Bash",
              rawUrl: body.eventConfig.databaseUrl,
            },
          },
        });
      }
      if (body.eventType === "notion-page-content-updated") {
        return respond(201, {
          ...notionPageContentUpdatedWorkflowAutomation(),
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            connectorId: "00000000-0000-4000-a000-000000000410",
            scope: body.eventConfig.pageUrl
              ? {
                  type: "page",
                  page: {
                    id: "33333333-3333-4333-8333-333333333333",
                    url: body.eventConfig.pageUrl,
                    title: "Release plan",
                    rawUrl: body.eventConfig.pageUrl,
                  },
                }
              : {
                  type: "data_source",
                  dataSource: {
                    id: "22222222-2222-4222-8222-222222222222",
                    url: body.eventConfig.databaseUrl ?? "",
                    title: "Bug Bash",
                    rawUrl: body.eventConfig.databaseUrl,
                  },
                },
          },
        });
      }
      if (body.eventConfig.provider === "github") {
        return respond(201, {
          ...gmailWorkflowAutomation(),
          eventType: body.eventType,
          eventConfig: body.eventConfig,
        } as ZeroWorkflowAutomationSummary);
      }
      return respond(201, {
        ...gmailWorkflowAutomation(),
        eventConfig: body.eventConfig,
      });
    },
  );
}

function mockUpdateWorkflowAutomation(
  onUpdate: (
    automationId: string,
    body: ZeroWorkflowAutomationUpdateRequest,
  ) => void,
): void {
  context.mocks.api(
    zeroWorkflowAutomationsContract.update,
    ({ params, body, respond }) => {
      onUpdate(params.id, body);
      if ("eventConfig" in body) {
        if (body.eventConfig.provider === "github") {
          if (body.eventConfig.event === "workflow_run_completed") {
            return respond(200, {
              ...githubLabelWorkflowAutomation(),
              id: params.id,
              eventType: "github-workflow-run-completed",
              eventConfig: body.eventConfig,
            });
          }
          if (body.eventConfig.event !== "label_applied") {
            return respond(200, {
              ...githubLabelWorkflowAutomation(),
              id: params.id,
              eventType:
                body.eventConfig.event === "workflow_job_completed"
                  ? "github-workflow-job-completed"
                  : body.eventConfig.event === "pull_request_review_submitted"
                    ? "github-pull-request-review-submitted"
                    : body.eventConfig.event === "deployment_status_created"
                      ? "github-deployment-status-created"
                      : "github-issue-comment-created",
              eventConfig: body.eventConfig,
            } as ZeroWorkflowAutomationSummary);
          }
          return respond(200, {
            ...githubLabelWorkflowAutomation(),
            id: params.id,
            eventConfig: body.eventConfig,
          });
        }
        if (body.eventConfig.event === "label_applied") {
          return respond(200, {
            ...gmailLabelWorkflowAutomation(),
            id: params.id,
            eventConfig: body.eventConfig,
          });
        }
        return respond(200, {
          ...gmailWorkflowAutomation(),
          id: params.id,
          eventConfig: body.eventConfig,
        });
      }
      return respond(200, {
        ...weekdayWorkflowAutomation(),
        id: params.id,
        schedule: body.schedule,
      });
    },
  );
}

function mockRunWorkflowAutomation(
  onRun: (automationId: string) => void,
): void {
  context.mocks.api(
    zeroWorkflowAutomationsContract.run,
    ({ params, respond }) => {
      onRun(params.id);
      return respond(201, {
        runId: null,
        chatThreadId: AUTOMATION_RUN_THREAD_ID,
      });
    },
  );
}

function mockDisableWorkflowAutomation(
  onDisable: (automationId: string) => void,
): void {
  context.mocks.api(
    zeroWorkflowAutomationsContract.disable,
    ({ params, respond }) => {
      onDisable(params.id);
      return respond(200, {
        ...weekdayWorkflowAutomation(),
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
        prompt: "help me refine the workflow /sales-research",
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

function linkByText(
  text: RoleTextMatch,
  container: ParentNode = document.body,
): HTMLElement {
  const links = queryAllByRoleFast("link", container);
  const link = links.find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!link) {
    throw new Error(`${matchLabel(text)} link not found`);
  }
  return link;
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

// The "Add automation" automation picker is a dialog split into category tabs on
// the left and automation cards on the right; a card only mounts once its category
// is active. Select the category, then the card (matched by its leading title,
// since cards also render a description line).
function pickAutomation(category: string, title: RoleTextMatch): void {
  const dialog = screen.getByRole("dialog");
  const tab = queryAllByRoleFast("button", dialog).find((candidate) => {
    return textFor(candidate) === category;
  });
  if (!tab) {
    throw new Error(`${category} automation category not found`);
  }
  click(tab);
  const card = queryAllByRoleFast("button", dialog).find((candidate) => {
    const text = textFor(candidate);
    return typeof title === "string"
      ? text.startsWith(title)
      : title.test(text);
  });
  if (!card) {
    throw new Error(`${matchLabel(title)} automation card not found`);
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
  it("renders the workspace workflows index", async () => {
    mockWorkflowApis([salesResearch()]);

    detachedSetupPage({
      context,
      path: "/workflows",
    });

    await waitFor(() => {
      expect(pathname()).toBe("/workflows");
      expect(
        screen.getByRole("heading", { name: "Workflows" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Sales Research")).toBeInTheDocument();
  });

  it("renders the workspace workflow detail", async () => {
    mockWorkflowApis([salesResearch()]);
    mockConnectedAutomationConnectors();

    detachedSetupPage({
      context,
      path: `/workflows/${SALES_WORKFLOW_ID}/automations`,
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/workflows/${SALES_WORKFLOW_ID}/automations`);
      expect(screen.getAllByText("Sales Research").length).toBeGreaterThan(0);
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

  it("filters the workspace workflows by agent", async () => {
    mockAgentPageApis();
    mockWorkflowApis([salesResearch(), opsPlaybook(), otherAgentWorkflow()]);

    detachedSetupPage({
      context,
      path: "/workflows",
    });

    await waitFor(() => {
      expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
    });
    // Every agent's workflows show under the default "All agents" scope.
    expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();

    // Scope the list to a single agent via the agent dropdown.
    click(buttonByText("All agents"));
    click(menuItemByText("Support Bot"));
    await waitFor(() => {
      expect(search()).toBe(`?agent=${OTHER_AGENT_ID}`);
    });
    expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();
    expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
    expect(screen.queryByText("Ops Playbook")).not.toBeInTheDocument();

    // The automation reflects the active agent; clearing returns everything.
    click(buttonByText("Support Bot"));
    click(menuItemByText("All agents"));
    await waitFor(() => {
      expect(search()).toBe("");
    });
    expect(linkByAriaLabel("Open Sales Research")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Ops Playbook")).toBeInTheDocument();
    expect(linkByAriaLabel("Open Support Intake")).toBeInTheDocument();
  });
});

describe("workflow detail page", () => {
  it("renders the instruction, files, and automations", async () => {
    context.mocks.data.userPreferences({ timezone: "UTC" });
    mockWorkflowApis([salesResearch()]);
    mockConnectedAutomationConnectors();

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
      screen.queryByRole("region", { name: "Connector readiness" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("This workflow belongs to this agent."),
    ).toBeInTheDocument();
    expect(screen.getByTitle("Research Bot")).toHaveTextContent("Research Bot");
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

  it("checks connector readiness only on request and shows every status", async () => {
    const workflow = {
      ...salesResearch(),
      canManage: false,
      canPublish: false,
    };
    const requestStarted = context.mocks.deferred<void>();
    const releaseResponse = context.mocks.deferred<void>();
    let requestCount = 0;
    mockWorkflowApis([workflow]);
    context.mocks.api(
      zeroWorkflowsDetailContract.connectorReadiness,
      async ({ params, respond }) => {
        expect(params.workflowId).toBe(SALES_WORKFLOW_ID);
        requestCount += 1;
        requestStarted.resolve();
        await releaseResponse.promise;
        return respond(200, {
          connectors: [
            {
              connectorRef: "google-drive",
              label: "Google Drive",
              icon: connectorIcon("google-drive"),
              reason: "The workflow reads account documents.",
              status: "connected",
            },
            {
              connectorRef: "github",
              label: "GitHub",
              icon: connectorIcon("github"),
              reason: "A GitHub automation requires this connector.",
              status: "unavailable",
            },
            {
              connectorRef: "slack",
              label: "Slack",
              icon: connectorIcon("slack"),
              reason: "The workflow posts a summary to Slack.",
              status: "not-enabled-for-agent",
            },
            {
              connectorRef: "notion",
              label: "Notion",
              icon: connectorIcon("notion"),
              reason: "The workflow updates a Notion page.",
              status: "scope-mismatch",
            },
            {
              connectorRef: "gmail",
              label: "Gmail",
              reason: "The workflow reads outreach replies.",
              status: "reconnect-required",
              icon: {
                url: "https://icons.example.test/gmail.svg",
                invertInDarkMode: true,
                scale: 1.25,
              },
            },
            {
              connectorRef: "linear",
              label: "Linear",
              icon: connectorIcon("linear"),
              reason: "The workflow creates follow-up issues.",
              status: "not-connected",
            },
          ],
        });
      },
    );

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"), {
      [FeatureSwitchKey.WorkflowConnectorReadiness]: true,
    });

    const readiness = await screen.findByRole("region", {
      name: "Connector readiness",
    });
    expect(requestCount).toBe(0);
    expect(within(readiness).queryByText("Gmail")).not.toBeInTheDocument();

    click(buttonByText("Check connectors", readiness));
    await requestStarted.promise;
    expect(requestCount).toBe(1);
    expect(buttonByText("Checking...", readiness)).toBeDisabled();

    releaseResponse.resolve();
    await waitFor(() => {
      expect(within(readiness).getByText("Gmail")).toBeInTheDocument();
    });
    const rows = within(readiness).getAllByRole("listitem");
    expect(
      rows.map((row) => {
        return row.querySelector("p")?.textContent;
      }),
    ).toStrictEqual([
      "Gmail",
      "Linear",
      "Notion",
      "Slack",
      "GitHub",
      "Google Drive",
    ]);
    expect(
      within(readiness).getByText("Reconnect required"),
    ).toBeInTheDocument();
    expect(
      within(readiness).getByText("Update permissions"),
    ).toBeInTheDocument();
    expect(within(readiness).getByText("Not connected")).toBeInTheDocument();
    expect(
      within(readiness).getByText("Not enabled for this agent"),
    ).toBeInTheDocument();
    expect(
      within(readiness).getByText("Currently unavailable"),
    ).toBeInTheDocument();
    expect(within(readiness).getByText("Connected")).toBeInTheDocument();

    const gmailRow = within(readiness).getByText("Gmail").closest("li");
    if (!(gmailRow instanceof HTMLElement)) {
      throw new Error("Gmail readiness row not found");
    }
    expect(gmailRow.querySelector("img")).toHaveAttribute(
      "src",
      "https://icons.example.test/gmail.svg",
    );
    expect(gmailRow.querySelector("img")).toHaveClass("zero-icon-mono");
    expect(gmailRow.querySelector("img")).toHaveStyle({
      transform: "scale(1.25)",
    });

    const unavailableRow = within(readiness).getByText("GitHub").closest("li");
    if (!(unavailableRow instanceof HTMLElement)) {
      throw new Error("Unavailable readiness row not found");
    }
    expect(unavailableRow.querySelector("img")).toHaveAttribute(
      "src",
      "https://icons.example.test/github.svg",
    );

    expect(linkByText("Reconnect Gmail", readiness)).toHaveAttribute(
      "href",
      `/connectors/gmail/connect?agentId=${encodeURIComponent(AGENT_ID)}`,
    );
    expect(linkByText("Enable for agent Slack", readiness)).toHaveAttribute(
      "href",
      `/connectors/slack/authorize?agentId=${encodeURIComponent(AGENT_ID)}`,
    );
    for (const link of queryAllByRoleFast("link", readiness)) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("shows actionable connector check errors and supports retry", async () => {
    let requestCount = 0;
    mockWorkflowApis([salesResearch()]);
    context.mocks.api(
      zeroWorkflowsDetailContract.connectorReadiness,
      ({ respond }) => {
        requestCount += 1;
        if (requestCount === 1) {
          return respond(413, {
            error: {
              code: "PAYLOAD_TOO_LARGE",
              message: "Workflow content is too long",
            },
          });
        }
        if (requestCount === 2) {
          return respond(503, {
            error: {
              code: "CONNECTOR_READINESS_TIMEOUT",
              message: "Connector check timed out",
            },
          });
        }
        return respond(200, { connectors: [] });
      },
    );

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"), {
      [FeatureSwitchKey.WorkflowConnectorReadiness]: true,
    });

    const readiness = await screen.findByRole("region", {
      name: "Connector readiness",
    });
    click(buttonByText("Check connectors", readiness));
    await expect(
      within(readiness).findByText(
        "This workflow is too long to check. Keep the name, description, and instructions within 100,000 characters.",
      ),
    ).resolves.toBeInTheDocument();

    click(buttonByText("Check again", readiness));
    await expect(
      within(readiness).findByText("The connector check timed out. Try again."),
    ).resolves.toBeInTheDocument();

    click(buttonByText("Check again", readiness));
    await expect(
      within(readiness).findByText("No required connectors detected"),
    ).resolves.toBeInTheDocument();
    expect(requestCount).toBe(3);
  });

  it("blocks checks for unsaved inputs and clears results after saving", async () => {
    const workflow = salesResearch();
    mockWorkflowApis([workflow]);
    context.mocks.api(
      zeroWorkflowsDetailContract.connectorReadiness,
      ({ respond }) => {
        return respond(200, {
          connectors: [
            {
              connectorRef: "gmail",
              label: "Gmail",
              icon: connectorIcon("gmail"),
              reason: "The workflow reads outreach replies.",
              status: "connected",
            },
          ],
        });
      },
    );

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"), {
      [FeatureSwitchKey.WorkflowConnectorReadiness]: true,
    });

    const readiness = await screen.findByRole("region", {
      name: "Connector readiness",
    });
    click(buttonByText("Check connectors", readiness));
    await expect(
      within(readiness).findByText("Gmail"),
    ).resolves.toBeInTheDocument();

    await fill(screen.getByLabelText("Name"), "Updated display name");
    expect(buttonByText("Check again", readiness)).toBeEnabled();

    await fill(screen.getByLabelText("Description"), "Updated description");
    expect(buttonByText("Check again", readiness)).toBeDisabled();
    expect(
      within(readiness).getByText(
        "Save your changes before checking connectors.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Save"));
    await waitFor(() => {
      expect(within(readiness).queryByText("Gmail")).not.toBeInTheDocument();
    });
    expect(buttonByText("Check connectors", readiness)).toBeEnabled();
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

  it("opens the shared workflow chat thread with the workflow refinement prompt", async () => {
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
    await expectComposerText("help me refine the workflow /sales-research");
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

  it("confirms before making a public workflow private", async () => {
    const demotedIds: string[] = [];
    mockWorkflowApis([salesResearch()]);
    context.mocks.api(
      zeroWorkflowVisibilityContract.demote,
      ({ params, respond }) => {
        demotedIds.push(params.workflowId);
        return respond(
          200,
          summary({ ...salesResearch(), visibility: "private" }),
        );
      },
    );

    detachedSetupWorkflowDetailPage(workflowDetailPath("info"));

    const toggle = await screen.findByRole("switch", {
      name: "Make workflow public",
    });
    expect(toggle).toBeEnabled();
    fireEvent.click(toggle);

    // Demoting a public workflow now requires an explicit confirmation.
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Make this workflow private?"),
    ).toBeInTheDocument();
    expect(demotedIds).toStrictEqual([]);

    // Cancelling leaves the workflow public and fires no request.
    click(buttonByText("Cancel", dialog));
    await waitFor(() => {
      expect(
        screen.queryByText("Make this workflow private?"),
      ).not.toBeInTheDocument();
    });
    expect(demotedIds).toStrictEqual([]);

    // Reopening and confirming demotes the workflow.
    fireEvent.click(
      await screen.findByRole("switch", { name: "Make workflow public" }),
    );
    const confirmDialog = await screen.findByRole("dialog");
    click(buttonByText("Make private", confirmDialog));
    await waitFor(() => {
      expect(demotedIds).toStrictEqual([SALES_WORKFLOW_ID]);
    });
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
      automations: [],
    };
    const copyRequests: {
      readonly workflowId: string;
      readonly toAgentId: string;
    }[] = [];
    const disabledAutomationIds: string[] = [];
    const deletedWorkflowIds: string[] = [];
    mockAgentPageApis();
    mockWorkflowApis(workflows);
    mockDisableWorkflowAutomation((automationId) => {
      disabledAutomationIds.push(automationId);
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
    expect(disabledAutomationIds).toStrictEqual([]);
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
      automations: [],
    };
    const copyRequests: {
      readonly workflowId: string;
      readonly toAgentId: string;
    }[] = [];
    const disabledAutomationIds: string[] = [];
    const deletedWorkflowIds: string[] = [];
    mockAgentPageApis();
    mockWorkflowApis(workflows);
    mockDisableWorkflowAutomation((automationId) => {
      disabledAutomationIds.push(automationId);
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
      expect(disabledAutomationIds).toStrictEqual([
        "workflow-automation-weekday-brief",
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

  it("renders Gmail new message automation match summaries", async () => {
    const workflow = {
      ...salesResearch(),
      automations: [...workflowAutomations(), gmailWorkflowAutomation()],
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
    // Only the schedule automation shows a "Next" run stat; event automations omit it.
    expect(screen.getAllByText("Next")).toHaveLength(1);
  });

  it("submits an automation run and navigates to the bound chat thread", async () => {
    const runAutomationIds: string[] = [];
    mockWorkflowApis([salesResearch()]);
    mockChatLifecycle(context, { threadId: AUTOMATION_RUN_THREAD_ID });
    mockRunWorkflowAutomation((automationId) => {
      runAutomationIds.push(automationId);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Run now")).toBeInTheDocument();
    });
    click(buttonByText("Run now"));

    await waitFor(() => {
      expect(runAutomationIds).toStrictEqual([
        "workflow-automation-weekday-brief",
      ]);
    });
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${AUTOMATION_RUN_THREAD_ID}`);
    });
    expect(search()).toBe("");
  });

  it("creates a Gmail new message automation with text match rules", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
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
    pickAutomation("Email", /^Gmail new message/);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add Gmail automation",
    });
    expect(within(createAutomationForm).getAllByRole("textbox")).toHaveLength(
      1,
    );
    expect(
      buttonByText("Remove condition 1", createAutomationForm),
    ).toBeDisabled();
    await fill(
      within(createAutomationForm).getByLabelText("From contains"),
      "@acme.com",
    );
    click(buttonByText("Add condition", createAutomationForm));
    expect(within(createAutomationForm).getAllByRole("textbox")).toHaveLength(
      2,
    );
    selectOptionByLabel("Condition 2 field", "Subject", createAutomationForm);
    selectOptionByLabel(
      "Condition 2 operator",
      "Does not contain",
      createAutomationForm,
    );
    await fill(
      within(createAutomationForm).getByLabelText("Subject does not contain"),
      "newsletter",
    );
    fireEvent.submit(createAutomationForm);

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

  it("hides Gmail thread matching while its rollout switch is disabled", async () => {
    mockWorkflowApis([salesResearch()]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickAutomation("Email", /^Gmail new message/);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add Gmail automation",
    });
    click(within(createAutomationForm).getByLabelText("Condition 1 field"));

    expect(
      screen.queryByRole("option", { name: "Thread ID" }),
    ).not.toBeInTheDocument();
  });

  it("creates a Gmail label applied automation with a label name", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
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
    pickAutomation("Email", /^Gmail label applied/);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add Gmail label automation",
    });
    await fill(
      within(createAutomationForm).getByLabelText("Label name"),
      "Support",
    );
    fireEvent.submit(createAutomationForm);

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

  it("creates a GitHub workflow run automation with native filters", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
      createBodies.push(body);
    });
    setMockGithubIntegration(createDefaultMockGithubIntegration());

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickAutomation("Integrations", /^GitHub workflow completed/);

    const form = await screen.findByRole("form", {
      name: "Add GitHub workflow automation",
    });
    await fill(within(form).getByLabelText("Repositories"), "vm0-ai/vm0");
    await fill(
      within(form).getByLabelText("GitHub workflows"),
      "Turbo, .github/workflows/turbo.yml",
    );
    await fill(within(form).getByLabelText("Branches"), "main");
    await fill(within(form).getByLabelText("Triggering events"), "push");
    await fill(within(form).getByLabelText("Actors"), "lancy");
    click(within(form).getByLabelText("Failure"));
    click(within(form).getByLabelText("Startup failure"));
    fireEvent.submit(form);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "github-workflow-run-completed",
        eventConfig: {
          provider: "github",
          event: "workflow_run_completed",
          filters: {
            repositories: ["vm0-ai/vm0"],
            workflows: ["Turbo", ".github/workflows/turbo.yml"],
            conclusions: ["failure", "startup_failure"],
            branches: ["main"],
            events: ["push"],
            actors: ["lancy"],
          },
        },
      });
    });
  });

  it("hides new GitHub webhook creation entries when the feature is disabled", async () => {
    mockWorkflowApis([salesResearch()]);
    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.GithubWebhookAutomations]: false,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    click(buttonByText("Integrations"));
    expect(
      screen.queryByText("GitHub issue comment created"),
    ).not.toBeInTheDocument();
  });

  it("creates a GitHub issue comment automation behind the feature switch", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
      createBodies.push(body);
    });
    setMockGithubIntegration(createDefaultMockGithubIntegration());

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.GithubWebhookAutomations]: true,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickAutomation("Integrations", /^GitHub issue comment created/);

    const form = await screen.findByRole("form", {
      name: "Add GitHub issue comment created automation",
    });
    await waitFor(() => {
      expect(within(form).getByLabelText("Trusted authors")).toBeEnabled();
    });
    await fill(within(form).getByLabelText("Repositories"), "vm0-ai/vm0");
    selectOptionByLabel("Subject", "Pull requests only", form);
    fireEvent.change(within(form).getByLabelText("Trusted authors"), {
      target: { value: "e7h4n, lancy" },
    });
    fireEvent.change(within(form).getByLabelText("Comment prefixes"), {
      target: { value: "/verify, /deploy" },
    });
    fireEvent.submit(form);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "github-issue-comment-created",
        eventConfig: {
          provider: "github",
          event: "issue_comment_created",
          filters: {
            repositories: ["vm0-ai/vm0"],
            subject: "pull_requests",
            trustedAuthors: ["e7h4n", "lancy"],
            commentPrefixes: ["/verify", "/deploy"],
          },
        },
      });
    });
  });

  it("creates a Google Calendar event-updated automation", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {});

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickAutomation("Calendar", /^Google Calendar event updated/);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add Google Calendar automation",
    });
    await fill(
      within(createAutomationForm).getByLabelText("Calendar ID"),
      "team@example.com",
    );
    fireEvent.submit(createAutomationForm);

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

  it("creates a Google Calendar event-cancelled automation", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {});

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickAutomation("Calendar", /^Google Calendar event cancelled/);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add Google Calendar automation",
    });
    await fill(
      within(createAutomationForm).getByLabelText("Calendar ID"),
      "team@example.com",
    );
    fireEvent.submit(createAutomationForm);

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

  it("creates a Google Meet transcript-generated automation", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {});

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickAutomation("Calendar", /^Google Meet transcript ready/);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add Google Meet transcript automation",
    });
    fireEvent.submit(createAutomationForm);

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

  it("creates a Notion database item automation", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
      createBodies.push(body);
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.NotionWorkflowAutomations]: true,
    });

    await waitFor(() => {
      expect(buttonByText("Add automation")).toBeInTheDocument();
    });
    click(buttonByText("Add automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    pickAutomation("Notion", /^New Notion database item/);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add Notion database item automation",
    });
    await fill(
      within(createAutomationForm).getByLabelText("Database URL"),
      "https://www.notion.so/22222222222242228222222222222222?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
    );
    fireEvent.submit(createAutomationForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "notion-database-item-created",
        eventConfig: {
          provider: "notion",
          event: "database_item_created",
          databaseUrl:
            "https://www.notion.so/22222222222242228222222222222222?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
        },
      });
    });
  });

  it("creates a webhook automation and shows one-time signing details", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
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
    pickAutomation("Integrations", /^Webhook/);
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
      webhookWorkflowAutomation().webhookUrl ?? "",
    );
    expect(webhookUrlField).toBeInTheDocument();
    expect(webhookUrlField).toHaveValue(
      webhookWorkflowAutomation().webhookUrl ?? "",
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

  it("shows Pro admins a locked Team webhook card and upgrade action", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    mockWorkflowApis([salesResearch()]);
    detachedSetupWorkflowDetailPage(
      workflowDetailPath("automations"),
      {},
      "pro",
    );

    click(await screen.findByText("Add automation"));
    const picker = await screen.findByRole("dialog");
    click(buttonByText("Integrations", picker));
    const webhookCard = buttonByText(/^Webhook/u, picker);
    expect(within(webhookCard).getByText("Team")).toBeInTheDocument();
    click(webhookCard);

    const upgradeTitle = await screen.findByText(
      "Upgrade for webhook automations",
    );
    expect(upgradeTitle).toBeInTheDocument();
    expect(
      screen.getByText(
        "Webhook automations require a Team or Custom workspace.",
      ),
    ).toBeInTheDocument();
    expect(buttonByText("Upgrade to Team")).toBeInTheDocument();
  });

  it("allows webhook creation when the plan capability overrides the tier", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    mockWorkflowApis([salesResearch()]);
    detachedSetupWorkflowDetailPage(
      workflowDetailPath("automations"),
      {},
      "pro",
      { workflowWebhookAutomationAllowed: true },
    );

    click(await screen.findByText("Add automation"));
    const picker = await screen.findByRole("dialog");
    click(buttonByText("Integrations", picker));
    const webhookCard = buttonByText(/^Webhook/u, picker);
    expect(within(webhookCard).queryByText("Team")).not.toBeInTheDocument();
    click(webhookCard);

    await expect(
      screen.findByText("Create webhook"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Upgrade for webhook automations"),
    ).not.toBeInTheDocument();
  });

  it("asks non-admins to contact an admin for webhook access", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    mockWorkflowApis([salesResearch()]);
    detachedSetupWorkflowDetailPage(
      workflowDetailPath("automations"),
      {},
      "pro",
    );

    click(await screen.findByText("Add automation"));
    const picker = await screen.findByRole("dialog");
    click(buttonByText("Integrations", picker));
    click(buttonByText(/^Webhook/u, picker));

    const askAdmin = await screen.findByText(
      "Ask a workspace admin to upgrade.",
    );
    expect(askAdmin).toBeInTheDocument();
    expect(screen.queryByText("Upgrade to Team")).not.toBeInTheDocument();
  });

  it("opens the Team upgrade dialog when webhook enable returns TEAM_REQUIRED", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    const workflow = {
      ...salesResearch(),
      automations: [
        {
          ...webhookWorkflowAutomation(),
          enabled: false,
          disabledReason: "paid_plan_required" as const,
        },
      ],
    };
    mockWorkflowApis([workflow]);
    context.mocks.api(zeroWorkflowAutomationsContract.enable, ({ respond }) => {
      return respond(402, {
        error: {
          code: "TEAM_REQUIRED",
          message: "Webhook automations require a Team or Custom workspace",
        },
      });
    });
    detachedSetupWorkflowDetailPage(
      workflowDetailPath("automations"),
      {},
      "pro",
    );

    click(await screen.findByRole("switch", { name: "Enable Webhook" }));
    const upgradeTitle = await screen.findByText(
      "Upgrade for webhook automations",
    );
    expect(upgradeTitle).toBeInTheDocument();
    expect(
      screen.getByText("Disabled — paid plan required"),
    ).toBeInTheDocument();
  });

  it("reveals an existing webhook secret on demand", async () => {
    const workflow = {
      ...salesResearch(),
      automations: [webhookWorkflowAutomation()],
    };
    mockWorkflowApis([workflow]);

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Webhook URL hidden")).toBeInTheDocument();
    });
    expect(
      screen.queryByDisplayValue(webhookWorkflowAutomation().webhookUrl ?? ""),
    ).not.toBeInTheDocument();
    click(buttonByText("More actions"));
    click(menuItemByText("View webhook secret"));
    click(await screen.findByText("Reveal secret"));

    const webhookUrlField = await screen.findByDisplayValue(
      webhookWorkflowAutomation().webhookUrl ?? "",
    );
    expect(webhookUrlField).toBeInTheDocument();
    expect(screen.getByDisplayValue("webhook-secret")).toHaveValue(
      "webhook-secret",
    );
  });

  it("creates a cron schedule automation from the preferred time zone", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
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
    pickAutomation("Schedule", /^Scheduled time/u);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add schedule automation",
    });
    expect(
      within(createAutomationForm).getByText("Time (Asia/Shanghai)"),
    ).toBeInTheDocument();
    expect(within(createAutomationForm).queryByText(/Saved as/u)).toBeNull();
    click(buttonByText("Add schedule", createAutomationForm));

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

  it("creates an interval automation from the automation menu", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
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
    pickAutomation("Schedule", /^Interval/u);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add interval automation",
    });
    selectOptionByLabel("Every", "30 minutes", createAutomationForm);
    click(buttonByText("Add interval", createAutomationForm));

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        schedule: {
          type: "loop",
          intervalSeconds: 1800,
        },
      });
    });
  });

  it("creates a one-time automation from the automation menu", async () => {
    const createBodies: ZeroWorkflowAutomationCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowAutomation((body) => {
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
    pickAutomation("Schedule", /^One-time run/u);

    const createAutomationForm = await screen.findByRole("form", {
      name: "Add one-time automation",
    });
    fireEvent.change(within(createAutomationForm).getByLabelText("Run at"), {
      target: { value: "2026-07-01T10:30" },
    });
    click(buttonByText("Add one-time run", createAutomationForm));

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

  it("updates a cron schedule automation from the preferred time zone", async () => {
    const updateBodies: {
      readonly automationId: string;
      readonly body: ZeroWorkflowAutomationUpdateRequest;
    }[] = [];
    context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
    const workflow = {
      ...salesResearch(),
      automations: [
        {
          ...weekdayWorkflowAutomation(),
          schedule: {
            type: "cron",
            cronExpression: "0 1 * * 1-5",
            timezone: "UTC",
          },
        } satisfies WorkflowScheduleAutomationSummary,
      ],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowAutomation((automationId, body) => {
      updateBodies.push({ automationId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Every weekday at 9:00 AM")).toBeInTheDocument();
    });

    click(buttonByText("Edit automation"));

    const updateAutomationForm = screen.getByRole("form", {
      name: "Update schedule automation",
    });
    selectOptionByLabel("Hour", "16", updateAutomationForm);
    selectOptionByLabel("Minute", "45", updateAutomationForm);
    click(buttonByText("Save schedule", updateAutomationForm));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        automationId: "workflow-automation-weekday-brief",
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

  it("updates a loop schedule automation from the edit dialog", async () => {
    const updateBodies: {
      readonly automationId: string;
      readonly body: ZeroWorkflowAutomationUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      automations: [
        {
          ...weekdayWorkflowAutomation(),
          schedule: {
            type: "loop",
            intervalSeconds: 3600,
          },
          scheduleSummary: "Every 3600s",
        } satisfies WorkflowScheduleAutomationSummary,
      ],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowAutomation((automationId, body) => {
      updateBodies.push({ automationId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Every 1 hour")).toBeInTheDocument();
    });

    click(buttonByText("Edit automation"));

    const updateAutomationForm = screen.getByRole("form", {
      name: "Update schedule automation",
    });
    selectOptionByLabel("Every", "30 minutes", updateAutomationForm);
    fireEvent.submit(updateAutomationForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        automationId: "workflow-automation-weekday-brief",
        body: {
          schedule: {
            type: "loop",
            intervalSeconds: 1800,
          },
        },
      });
    });
  });

  it("updates a Gmail new message automation with text match rules", async () => {
    const updateBodies: {
      readonly automationId: string;
      readonly body: ZeroWorkflowAutomationUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      automations: [
        {
          ...gmailWorkflowAutomation(),
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            threadId: "gmail-thread-1",
            match: {
              from: { containsAny: ["@vip.example"] },
              subject: { doesNotContain: "newsletter" },
            },
          },
        } satisfies WorkflowGmailNewMessageAutomationSummary,
      ],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowAutomation((automationId, body) => {
      updateBodies.push({ automationId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"), {
      [FeatureSwitchKey.ZeroMailReplyFollowUp]: true,
    });

    await waitFor(() => {
      expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(
        0,
      );
    });

    click(buttonByText("Edit automation"));

    const updateAutomationForm = screen.getByRole("form", {
      name: "Update Gmail new message automation",
    });
    expect(
      within(updateAutomationForm).getByLabelText("Subject does not contain"),
    ).toHaveValue("newsletter");
    expect(
      within(updateAutomationForm).getByLabelText("From contains any"),
    ).toHaveValue("@vip.example");
    await fill(
      within(updateAutomationForm).getByLabelText("From contains any"),
      "@vip.example, @priority.example",
    );
    expect(
      within(updateAutomationForm).getByLabelText("Thread ID is"),
    ).toHaveValue("gmail-thread-1");
    expect(
      within(updateAutomationForm).getByLabelText("Condition 3 field"),
    ).toHaveTextContent("Thread ID");
    expect(
      within(updateAutomationForm).getByLabelText("Condition 3 operator"),
    ).toHaveTextContent("Is");
    await fill(
      within(updateAutomationForm).getByLabelText("Thread ID is"),
      "gmail-thread-2",
    );
    click(buttonByText("Add condition", updateAutomationForm));
    await fill(
      within(updateAutomationForm).getByLabelText("From contains"),
      "@acme.com",
    );
    click(buttonByText("Add condition", updateAutomationForm));
    selectOptionByLabel("Condition 5 field", "Body", updateAutomationForm);
    await fill(
      within(updateAutomationForm).getByLabelText("Body contains"),
      "invoice",
    );
    fireEvent.submit(updateAutomationForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        automationId: GMAIL_AUTOMATION_ID,
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            threadId: "gmail-thread-2",
            match: {
              from: {
                contains: "@acme.com",
                containsAny: ["@vip.example", "@priority.example"],
              },
              subject: { doesNotContain: "newsletter" },
              body: { contains: "invoice" },
            },
          },
        },
      });
    });
  });

  it("updates a Gmail label applied automation with a label name", async () => {
    const updateBodies: {
      readonly automationId: string;
      readonly body: ZeroWorkflowAutomationUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      automations: [gmailLabelWorkflowAutomation()],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowAutomation((automationId, body) => {
      updateBodies.push({ automationId, body });
    });

    detachedSetupWorkflowDetailPage(workflowDetailPath("automations"));

    await waitFor(() => {
      expect(screen.getByText("Gmail label applied")).toBeInTheDocument();
    });

    click(buttonByText("Edit automation"));

    const updateAutomationForm = screen.getByRole("form", {
      name: "Update Gmail label automation",
    });
    await fill(
      within(updateAutomationForm).getByLabelText("Label name"),
      "Escalated",
    );
    fireEvent.submit(updateAutomationForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        automationId: GMAIL_LABEL_AUTOMATION_ID,
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
