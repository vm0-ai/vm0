import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { chatThreadArtifactsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  FeatureSwitchKey,
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
} from "@okouai/core";
import { goalsContract } from "@okouai/api-contracts/contracts/goals";
import type {
  ChatThreadWorkflowAutomation,
  WorkflowAutomationUpdateRequest,
} from "@okouai/api-contracts/contracts/workflows";
import {
  createMockWorkflowAutomation,
  setMockWorkflowAutomations,
} from "../../../mocks/handlers/workflow-automations-store.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { canonicalUserMessageFileUrl } from "../../../signals/chat-page/user-message-files.ts";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../../../signals/chat-page/workflow-prompt-action";
import {
  context,
  detachedSetupPage,
  AGENT_ID,
  AUTOMATION_THREAD_ID,
  readSingleRichClipboardWrite,
  readClipboardItemText,
  parseChatClipboardPayload,
  expectTextBefore,
  mockAutomationThread,
  mockWorkflowAutomationUpdate,
  buttonByText,
  findWorkflowComposerEditor,
  mockWorkflowComposerWorkflows,
  selectOptionByLabel,
  openAutomationSidebarWithWorkflowAutomation,
  buttonByLabel,
} from "./chat-lifecycle-test-helpers.ts";

describe("chat lifecycle", () => {
  it("does not render a rejected goal continuation after an assistant response", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000001";
    const objectiveBrief = "Keep the launch moving";
    const machineReason = "internal provider credential id abc123 is invalid";
    const assistantResponse = "The active goal has been stopped.";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Rejected goal artifact",
      chatEvents: [
        {
          id: "msg-assistant-response",
          role: "assistant",
          content: assistantResponse,
          createdAt: "2026-07-29T10:00:00Z",
        },
        {
          id: "msg-rejected-goal",
          role: "user",
          eventType: "input.rejected",
          content: objectiveBrief,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief: objectiveBrief }],
          },
          error: machineReason,
          createdAt: "2026-07-29T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const renderedAssistantResponse =
      await screen.findByText(assistantResponse);
    expect(renderedAssistantResponse).toBeInTheDocument();
    expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
    expect(screen.queryByText(objectiveBrief)).not.toBeInTheDocument();
    expect(screen.queryByText(machineReason)).not.toBeInTheDocument();
  });

  it("hides a rejected automation replacement without hiding other rejected input", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000021";
    const automationPrompt = "A run in the watched chat thread completed.";
    const rejectedPrompt = "Summarize the completed run";
    const assistantResponse = "The active run has completed.";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Rejected automation event",
      chatEvents: [
        {
          id: "msg-assistant-response",
          role: "assistant",
          content: assistantResponse,
          createdAt: "2026-08-15T07:13:23Z",
        },
        {
          id: "msg-pending-automation",
          eventType: "input.automation",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: automationPrompt },
              {
                type: "automation",
                workflowName: "chat-run-finished-callback",
              },
            ],
          },
          createdAt: "2026-08-15T07:12:33Z",
        },
        {
          id: "msg-rejected-automation",
          eventType: "input.rejected",
          content: automationPrompt,
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: automationPrompt },
              {
                type: "automation",
                workflowName: "chat-run-finished-callback",
              },
            ],
          },
          revokesEventId: "msg-pending-automation",
          error: "Workflow automation is paused or no longer readable",
          createdAt: "2026-08-15T07:13:24Z",
        },
        {
          id: "msg-pending-prompt",
          role: "user",
          content: rejectedPrompt,
          createdAt: "2026-08-15T07:13:25Z",
        },
        {
          id: "msg-rejected-prompt",
          eventType: "input.rejected",
          content: rejectedPrompt,
          revokesEventId: "msg-pending-prompt",
          error: "Prompt could not be started",
          createdAt: "2026-08-15T07:13:26Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const renderedAssistantResponse =
      await screen.findByText(assistantResponse);
    expect(renderedAssistantResponse).toBeInTheDocument();
    expect(screen.queryByText(automationPrompt)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Workflow chat-run-finished-callback"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(rejectedPrompt)).toBeInTheDocument();
  });

  it("opens run details from assistant message actions when debug is enabled", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e9000000-0000-4000-a000-000000000002";
    const runId = "a0000000-0000-4000-a000-000000000001";
    const assistantReply = "The launch summary is ready to share.";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Run logs message",
      chatEvents: [
        {
          id: "msg-run-logs-user",
          role: "user",
          content: "Summarize the launch update",
          runId,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-run-logs-assistant",
          role: "assistant",
          content: assistantReply,
          runId,
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("View run logs"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "zero" })).toBeInTheDocument();
    });
  });

  it("copies an assistant response from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const threadId = "e9000000-0000-4000-a000-000000000003";
    const assistantReply = "The launch summary is ready to share.";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Assistant copy",
      chatEvents: [
        {
          id: "msg-assistant-copy-user",
          role: "user",
          content: "Summarize the launch update",
          runId: "run-assistant-copy",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-copy-response",
          role: "assistant",
          content: assistantReply,
          runId: "run-assistant-copy",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
    });

    const assistantGroup = screen
      .getByText(assistantReply)
      .closest('[data-role="assistant"]');
    if (!(assistantGroup instanceof HTMLElement)) {
      throw new Error("assistant message group not found");
    }
    click(within(assistantGroup).getByLabelText("Copy message"));

    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([assistantReply]);
    });
  });

  it("starts a workflow prompt from the composer when the composer is empty", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e9000000-0000-4000-a000-000000000004";
    const assistantReply = "We can turn this into a workflow.";
    mockWorkflowComposerWorkflows();
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Assistant workflow",
      chatEvents: [
        {
          id: "msg-workflow-empty-user",
          role: "user",
          content: "Make this repeatable",
          runId: "run-workflow-empty",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-empty-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-workflow-empty",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const assistantEvent = await screen.findByText(assistantReply);
    const assistantGroup = assistantEvent.closest('[data-role="assistant"]');
    if (!(assistantGroup instanceof HTMLElement)) {
      throw new Error("assistant message group not found");
    }
    expect(
      within(assistantGroup).queryByLabelText("Create workflow"),
    ).not.toBeInTheDocument();
    const templateButton = buttonByLabel("Template");
    const workflowButton = buttonByLabel("Create workflow");
    expect(
      templateButton.compareDocumentPosition(workflowButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.hover(workflowButton);
    const workflowTooltip = await screen.findByText("Create workflow", {
      selector: "div",
    });
    await waitFor(() => {
      expect(workflowTooltip).toBeVisible();
    });
    await user.unhover(workflowButton);

    click(workflowButton);

    const editor = await findWorkflowComposerEditor();
    await waitFor(() => {
      expect(editor).toHaveTextContent(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
    });
    expect(
      screen.queryByRole("dialog", { name: "Replace composer draft?" }),
    ).not.toBeInTheDocument();
  });

  it("confirms before replacing an existing composer draft with a workflow prompt", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000005";
    const assistantReply = "This is a good workflow candidate.";
    const draft = "Keep this draft";
    mockWorkflowComposerWorkflows();
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Assistant workflow draft",
      chatEvents: [
        {
          id: "msg-workflow-draft-user",
          role: "user",
          content: "Can this be automated?",
          runId: "run-workflow-draft",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-draft-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-workflow-draft",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const editor = await findWorkflowComposerEditor();
    await fill(editor, draft);
    await waitFor(() => {
      expect(editor).toHaveTextContent(draft);
    });

    await screen.findByText(assistantReply);
    const workflowButton = buttonByLabel("Create workflow");

    click(workflowButton);

    const dialog = await screen.findByRole("dialog", {
      name: "Replace composer draft?",
    });
    expect(
      within(dialog).getByText(
        "Continuing will clear your current composer draft and start a workflow prompt.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Cancel", dialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Replace composer draft?" }),
      ).not.toBeInTheDocument();
      expect(editor).toHaveTextContent(draft);
    });

    click(workflowButton);
    const confirmDialog = await screen.findByRole("dialog", {
      name: "Replace composer draft?",
    });
    click(buttonByText("Continue", confirmDialog));

    await waitFor(() => {
      expect(editor).toHaveTextContent(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
      expect(editor).not.toHaveTextContent(draft);
    });
  });

  it("lists workflow automations in the sidebar", async () => {
    mockAutomationThread();
    setMockWorkflowAutomations([
      createMockWorkflowAutomation({
        id: "e0000001-0000-4000-a000-000000000002",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "schedule",
        scheduleSummary: "Every 60s",
        workflow: {
          id: "a0000001-0000-4000-a000-000000000002",
          name: "nightly-sync",
          displayName: "Nightly sync",
          description: "Sync the changelog every night",
        },
      }),
    ]);
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${AUTOMATION_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(buttonByLabel("Automations")).toBeInTheDocument();
    });

    click(buttonByLabel("Automations"));

    await waitFor(() => {
      expect(screen.getByTestId("automation-sidebar")).toBeInTheDocument();
    });

    const sidebar = screen.getByTestId("automation-sidebar");
    expect(within(sidebar).getByText("Nightly sync")).toBeInTheDocument();
    expect(within(sidebar).getByText("View")).toBeInTheDocument();
    expect(within(sidebar).getByText("Status")).toBeInTheDocument();
    expect(within(sidebar).getByText("Active")).toBeInTheDocument();
    expect(within(sidebar).getAllByText("Schedule").length).toBeGreaterThan(0);
    expect(within(sidebar).getByText("Every 1 minute")).toBeInTheDocument();
    expect(within(sidebar).getByText("Last run")).toBeInTheDocument();
    expect(within(sidebar).getByText("No runs yet")).toBeInTheDocument();
    expect(within(sidebar).getAllByText("Next run").length).toBeGreaterThan(0);
    expect(
      within(sidebar).getAllByText("No upcoming run").length,
    ).toBeGreaterThan(0);
    expect(
      within(sidebar).queryByText("Authorization"),
    ).not.toBeInTheDocument();

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Edit automation" }),
      ).toBeInTheDocument();
    });
    const editDialog = screen.getByRole("dialog", {
      name: "Edit automation",
    });
    expect(
      within(editDialog).getByRole("combobox", { name: "Every" }),
    ).toHaveTextContent("1 minute");
    expect(
      within(editDialog).queryByLabelText("Interval seconds"),
    ).not.toBeInTheDocument();
  });

  it("shows webhook automations in the sidebar without edit controls", async () => {
    const automation: ChatThreadWorkflowAutomation = {
      id: "e0000001-0000-4000-a000-000000000006",
      ownerUserId: "test-user-123",
      enabled: true,
      chatThreadId: AUTOMATION_THREAD_ID,
      nextRunAt: null,
      lastRunAt: null,
      official: null,
      workflow: {
        id: "a0000001-0000-4000-a000-000000000006",
        agentId: AGENT_ID,
        name: "webhook-sync",
        displayName: "Webhook sync",
        description: "Sync external webhook events",
      },
      kind: "event",
      eventType: "webhook-received",
      eventConfig: {
        provider: "webhook",
        event: "received",
        auth: { mode: "hmac-sha256" },
      },
      schedule: null,
      scheduleSummary: null,
      secretLastFour: "cafe",
      disabledReason: null,
      lastReceivedAt: null,
    };

    const sidebar =
      await openAutomationSidebarWithWorkflowAutomation(automation);

    expect(within(sidebar).getByText("Webhook sync")).toBeInTheDocument();
    expect(within(sidebar).getByText("Webhook automation")).toBeInTheDocument();
    expect(within(sidebar).getByText("View")).toBeInTheDocument();
    expect(within(sidebar).getByText("Run now")).toBeInTheDocument();
    expect(within(sidebar).queryByText("Edit")).not.toBeInTheDocument();
  });

  it("shows a disabled workflow automation status in the sidebar", async () => {
    const sidebar = await openAutomationSidebarWithWorkflowAutomation(
      createMockWorkflowAutomation({
        id: "e0000001-0000-4000-a000-000000000007",
        chatThreadId: AUTOMATION_THREAD_ID,
        enabled: false,
        workflow: {
          displayName: "Nightly sync",
        },
      }),
    );

    expect(within(sidebar).getByText("Disabled")).toBeInTheDocument();
    expect(within(sidebar).queryByRole("switch")).not.toBeInTheDocument();
  });

  it("updates a schedule workflow automation from the sidebar", async () => {
    const updateBodies: {
      readonly automationId: string;
      readonly body: WorkflowAutomationUpdateRequest;
    }[] = [];
    const sidebar = await openAutomationSidebarWithWorkflowAutomation(
      createMockWorkflowAutomation({
        id: "e0000001-0000-4000-a000-000000000003",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 3600 },
        scheduleSummary: "Every 3600s",
      }),
    );
    mockWorkflowAutomationUpdate((automationId, body) => {
      updateBodies.push({ automationId, body });
    });

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    const dialog = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    selectOptionByLabel("Every", "30 minutes", dialog);
    click(buttonByText("Save automation", dialog));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        automationId: "e0000001-0000-4000-a000-000000000003",
        body: {
          schedule: {
            type: "loop",
            intervalSeconds: 1800,
          },
        },
      });
    });
  });

  it("updates a Gmail workflow automation match from the sidebar", async () => {
    const updateBodies: {
      readonly automationId: string;
      readonly body: WorkflowAutomationUpdateRequest;
    }[] = [];
    const sidebar = await openAutomationSidebarWithWorkflowAutomation(
      createMockWorkflowAutomation({
        id: "e0000001-0000-4000-a000-000000000004",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          threadId: "gmail-thread-1",
          match: {
            from: { containsAny: ["customer@example.com"] },
            subject: { doesNotContain: "newsletter" },
          },
        },
      }),
    );
    // Event automations must not show a "Next run" row — only schedule automations do.
    expect(within(sidebar).queryByText("Next run")).not.toBeInTheDocument();
    expect(within(sidebar).getByText("Last run")).toBeInTheDocument();
    mockWorkflowAutomationUpdate((automationId, body) => {
      updateBodies.push({ automationId, body });
    });

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    const dialog = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    expect(within(dialog).getByLabelText("From contains any")).toHaveValue(
      "customer@example.com",
    );
    expect(within(dialog).getByLabelText("Thread ID value")).toHaveValue(
      "gmail-thread-1",
    );
    // The field and operator cells are fixed for a thread-scoped automation, so
    // they must not look editable next to the value cell.
    expect(within(dialog).getByLabelText("Thread ID field")).toBeDisabled();
    expect(within(dialog).getByLabelText("Thread ID operator")).toBeDisabled();
    await fill(
      within(dialog).getByLabelText("Thread ID value"),
      "gmail-thread-2",
    );
    await fill(within(dialog).getByLabelText("From contains"), "@acme.com");
    await fill(within(dialog).getByLabelText("Body contains"), "invoice");
    click(buttonByText("Save automation", dialog));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        automationId: "e0000001-0000-4000-a000-000000000004",
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            threadId: "gmail-thread-2",
            match: {
              from: {
                contains: "@acme.com",
                containsAny: ["customer@example.com"],
              },
              subject: { doesNotContain: "newsletter" },
              body: { contains: "invoice" },
            },
          },
        },
      });
    });
  });

  it("updates a Gmail label workflow automation from the sidebar", async () => {
    const updateBodies: {
      readonly automationId: string;
      readonly body: WorkflowAutomationUpdateRequest;
    }[] = [];
    const sidebar = await openAutomationSidebarWithWorkflowAutomation(
      createMockWorkflowAutomation({
        id: "e0000001-0000-4000-a000-000000000005",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Support",
        },
      }),
    );
    mockWorkflowAutomationUpdate((automationId, body) => {
      updateBodies.push({ automationId, body });
    });

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    const dialog = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    await fill(within(dialog).getByLabelText("Label name"), "Escalated");
    click(buttonByText("Save automation", dialog));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        automationId: "e0000001-0000-4000-a000-000000000005",
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

  it("does not use a goal queue event as composer goal state", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000722";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-goal-queued",
          eventType: "input.goal",
          runId: undefined,
          content: null,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief: "Finish the queued goal" }],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Active goal")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Finish the queued goal"),
    ).not.toBeInTheDocument();
  });

  it("folds a future close followed by an open into the reopened goal row", async () => {
    const threadId = "b0000000-0000-4000-a000-000000000734";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Future goal markers",
      chatEvents: [
        {
          id: "msg-goal-content-user",
          threadId,
          eventType: "input.prompt",
          role: "user",
          content: "Track this objective",
          runId: "run-goal-content",
          seqId: 1,
          createdAt: "2026-06-09T09:59:59Z",
        },
        {
          id: "msg-goal-content-assistant",
          threadId,
          eventType: "output.thinking",
          role: "assistant",
          content: null,
          thinking: "Working",
          runId: "run-goal-content",
          seqId: 2,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-content-open",
          threadId,
          eventType: "goal.open",
          role: "assistant",
          content: "Initial objective",
          runId: undefined,
          seqId: 3,
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-goal-content-close",
          threadId,
          eventType: "goal.close",
          role: "assistant",
          content: null,
          runId: undefined,
          seqId: 4,
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-goal-content-reopen",
          threadId,
          eventType: "goal.open",
          role: "assistant",
          content: "Reopened objective",
          runId: undefined,
          seqId: 5,
          createdAt: "2026-06-09T10:00:03Z",
        },
      ],
      activeRunIds: ["run-goal-content"],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Track this objective")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Active goal")).toHaveTextContent(
        "Reopened objective",
      );
    });
    expect(screen.queryByText("Initial objective")).not.toBeInTheDocument();
    expect(screen.getAllByText("Reopened objective")).toHaveLength(1);
  });

  it("folds goal-state markers into the goal row beneath queued work", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "b0000000-0000-4000-a000-000000000723";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-goal-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
        // Goal-state marker carrying the objective brief; the fold should
        // surface the goal while keeping the marker out of transcript bubbles.
        {
          id: "msg-goal-active",
          eventType: "goal.open",
          runId: undefined,
          role: "assistant",
          content: "Drive the release to merge",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-goal-automation",
          eventType: "input.automation",
          role: "user",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "release-follow-up",
                automationBrief: "First queued follow-up",
              },
            ],
          },
          runId: undefined,
          createdAt: "2026-06-09T10:00:03Z",
        },
      ],
      activeRunIds: ["run-active"],
    });
    let pausedGoalThreadId: string | null = null;
    context.mocks.api(
      goalsContract.pauseForChatThread,
      ({ params, respond }) => {
        pausedGoalThreadId = params.threadId;
        return respond(200, {
          objective: "Drive the release to merge",
          objectiveBrief: "Drive the release to merge",
          status: "paused",
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    // The folded goal surfaces above the composer.
    await waitFor(() => {
      expect(screen.getByLabelText("Active goal")).toHaveTextContent(
        "Drive the release to merge",
      );
    });
    // The marker is a control row — it must not also render as a chat bubble.
    expect(screen.getAllByText("Drive the release to merge")).toHaveLength(1);

    // The goal is the lowest-priority row: it sits after every queued item.
    await expect(
      screen.findByLabelText("Pending automation event"),
    ).resolves.toHaveTextContent("First queued follow-up");
    const goalRow = screen.getByLabelText("Active goal");
    const strip = goalRow.closest('[role="list"]');
    expect(strip).not.toBeNull();
    const rows = within(strip as HTMLElement).getAllByRole("listitem");
    const goalIndex = rows.indexOf(goalRow);
    const queuedIndex = rows.findIndex((row) => {
      return row.getAttribute("aria-label") === "Pending automation event";
    });
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    expect(goalIndex).toBeGreaterThan(queuedIndex);

    // Cancelling the goal row pauses the active goal by thread.
    await user.click(within(goalRow).getByLabelText("Cancel goal"));
    await waitFor(() => {
      expect(pausedGoalThreadId).toBe(threadId);
    });
  });

  it("opens an active goal objective dialog from the goal row", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "e9000000-0000-4000-a000-000000000006";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-goal-dialog-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-dialog-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-goal-dialog-active",
          eventType: "goal.open",
          runId: undefined,
          role: "assistant",
          content: "Release brief",
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });
    let requestedThreadId: string | null = null;
    context.mocks.api(goalsContract.getForChatThread, ({ params, respond }) => {
      requestedThreadId = params.threadId;
      return respond(200, {
        objective: "# Full goal\n\n- Keep **shipping**\n- Review `objective`",
        objectiveBrief: "Release brief",
        status: "active",
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const goalRow = await screen.findByLabelText("Active goal");
    await user.click(within(goalRow).getByLabelText("Open goal details"));

    const dialog = await screen.findByRole("dialog", { name: "Goal" });
    expect(requestedThreadId).toBe(threadId);
    await expect(
      within(dialog).findByRole("heading", { name: "Full goal" }),
    ).resolves.toBeInTheDocument();
    expect(dialog.querySelector(".wmde-markdown")).not.toBeNull();
  });

  it("hides the goal row once a completion marker folds in", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000007";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-goalc-active",
          eventType: "goal.open",
          runId: undefined,
          role: "assistant",
          content: "Drive the release to merge",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goalc-complete",
          eventType: "goal.close",
          runId: undefined,
          role: "assistant",
          content: null,
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
    // Latest state marker is complete → no goal row.
    expect(screen.queryByLabelText("Active goal")).not.toBeInTheDocument();
  });

  it("folds non-goal runs that share a run group id", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000008";
    const runGroupId = "f0000001-0000-4000-a000-00000000071b";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Non-goal run group folding",
      chatEvents: [
        {
          id: "msg-non-goal-run-group-user-1",
          role: "user",
          content: "First non-goal prompt",
          runId: "f0000001-0000-4000-a000-00000000071c",
          runGroupId,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-non-goal-run-group-assistant-1",
          role: "assistant",
          content: "First non-goal result",
          runId: "f0000001-0000-4000-a000-00000000071c",
          runGroupId,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-non-goal-run-group-user-2",
          role: "user",
          content: "Latest non-goal prompt",
          runId: "f0000001-0000-4000-a000-00000000071d",
          runGroupId,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-non-goal-run-group-assistant-2",
          role: "assistant",
          content: "Latest non-goal result",
          runId: "f0000001-0000-4000-a000-00000000071d",
          runGroupId,
          createdAt: "2026-06-09T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Latest non-goal prompt")).toBeInTheDocument();
      expect(screen.getByText("Latest non-goal result")).toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toBeInTheDocument();
      expect(
        screen.queryByText("First non-goal prompt"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("First non-goal result"),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(buttonByLabel("Expand grouped run history"));

    await waitFor(() => {
      expect(screen.getByText("First non-goal prompt")).toBeInTheDocument();
      expect(screen.getByText("First non-goal result")).toBeInTheDocument();
    });
  });

  it("surfaces archived goal history in the latest assistant row", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000009";
    const runGroupId = "f0000001-0000-4000-a000-00000000072b";
    const goalBrief = "Keep the release moving";
    const goalPrompt = `${goalBrief}

Full autonomous goal prompt that should stay out of the compact chat UI`;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Goal run group folding",
      chatEvents: [
        {
          id: "msg-goal-run-group-user-1",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-00000000072c",
          runGroupId,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-run-group-assistant-1",
          role: "assistant",
          content: "First goal result",
          runId: "f0000001-0000-4000-a000-00000000072c",
          runGroupId,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-goal-run-group-user-2",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-goal-run-group-assistant-2a",
          role: "assistant",
          content: "Checking the current goal state.",
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          createdAt: "2026-06-09T10:02:10Z",
        },
        {
          id: "msg-goal-run-group-assistant-2b",
          role: "assistant",
          content: "Latest goal result",
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Latest goal result")).toBeInTheDocument();
      expect(screen.getByLabelText("Goal")).toBeInTheDocument();
      expect(screen.getByText(goalBrief)).toBeInTheDocument();
      expect(screen.queryByText(goalPrompt)).not.toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "3 mins for Keep the release moving",
      );
      expect(screen.queryByText("Worked for 30s")).not.toBeInTheDocument();
      expect(screen.queryByText("First goal result")).not.toBeInTheDocument();
    });

    const latestAssistantGroup = screen
      .getByText("Latest goal result")
      .closest('[data-role="assistant"]') as HTMLElement | null;
    expect(latestAssistantGroup).not.toBeNull();
    expect(
      within(latestAssistantGroup!).getByText(
        "3 mins for Keep the release moving",
      ),
    ).toBeInTheDocument();
    expectTextBefore(
      document.body,
      goalBrief,
      "3 mins for Keep the release moving",
    );
    expectTextBefore(
      latestAssistantGroup!,
      "3 mins for Keep the release moving",
      "Latest goal result",
    );

    fireEvent.click(buttonByLabel("Expand grouped run history"));

    await waitFor(() => {
      expect(screen.getByText("First goal result")).toBeInTheDocument();
      expect(screen.getAllByText(goalBrief).length).toBeGreaterThan(1);
      expect(screen.queryByText(goalPrompt)).not.toBeInTheDocument();
      expect(screen.getAllByText("Worked for 30s").length).toBeGreaterThan(0);
    });
  });

  it("folds goal continuations into their triggering run work", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000023";
    const runGroupId = "f0000001-0000-4000-a000-000000000b2b";
    const goalBrief = "Keep the release moving";
    const goalPrompt = `${goalBrief}\n\nFull autonomous goal prompt`;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Goal run work folding",
      chatEvents: [
        {
          id: "msg-goal-work-trigger-user",
          role: "user",
          content: "Resume the release goal",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Resume the release goal" },
              { type: "model", selectedModel: "gpt-5.5" },
            ],
          },
          runId: "f0000001-0000-4000-a000-000000000b2c",
          createdAt: "2026-09-03T10:00:00Z",
        },
        {
          id: "msg-goal-work-trigger-assistant",
          role: "assistant",
          content: "The goal is running again.",
          runId: "f0000001-0000-4000-a000-000000000b2c",
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T10:00:10Z",
        },
        {
          id: "msg-goal-work-user-1",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [
              { type: "goal", goalBrief },
              { type: "model", selectedModel: "claude-sonnet-4-6" },
            ],
          },
          runId: "f0000001-0000-4000-a000-000000000b2d",
          runGroupId,
          createdAt: "2026-09-03T10:01:00Z",
        },
        {
          id: "msg-goal-work-assistant-1",
          role: "assistant",
          content: "Checked the first release blocker.",
          runId: "f0000001-0000-4000-a000-000000000b2d",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T10:01:30Z",
        },
        {
          id: "msg-goal-work-user-2",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [
              { type: "goal", goalBrief },
              { type: "model", selectedModel: "claude-sonnet-4-6" },
            ],
          },
          runId: "f0000001-0000-4000-a000-000000000b2e",
          runGroupId,
          createdAt: "2026-09-03T10:02:00Z",
        },
        {
          id: "msg-goal-work-assistant-final",
          role: "assistant",
          content: "The release is ready.",
          runId: "f0000001-0000-4000-a000-000000000b2e",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T10:03:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatRunWorkFolding]: true,
      },
    });

    const expandWork = await screen.findByLabelText("Expand work history");
    expect(expandWork).toHaveTextContent("Worked for 3m");
    expect(screen.getByText("Resume the release goal")).toBeInTheDocument();
    expect(screen.getByText("The release is ready.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
    expect(screen.queryByText(goalBrief)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Expand grouped run history"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("The goal is running again."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Checked the first release blocker."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Model changed to Claude Sonnet 4.6"),
    ).not.toBeInTheDocument();

    fireEvent.click(expandWork);

    await waitFor(() => {
      expect(
        screen.getByText("The goal is running again."),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Checked the first release blocker."),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Model changed to Claude Sonnet 4.6"),
      ).toBeInTheDocument();
    });
    expectTextBefore(
      document.body,
      "The goal is running again.",
      "Model changed to Claude Sonnet 4.6",
    );
    expectTextBefore(
      document.body,
      "Model changed to Claude Sonnet 4.6",
      "Checked the first release blocker.",
    );
    expect(screen.queryByText(goalBrief)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Expand grouped run history"),
    ).not.toBeInTheDocument();
  });

  it("starts a separate goal work fold after a new trigger", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000024";
    const runGroupId = "f0000001-0000-4000-a000-000000000c2b";
    const goalBrief = "Finish the release goal";
    const goalPrompt = `${goalBrief}\n\nFull autonomous goal prompt`;

    const segments = [
      {
        triggerId: "msg-goal-segment-start-user",
        triggerText: "Start the release goal",
        triggerResponse: "The release goal has started.",
        triggerRunId: "f0000001-0000-4000-a000-000000000c2c",
        goalInputId: "msg-goal-segment-start-input",
        goalResponse: "The first goal segment finished.",
        goalRunId: "f0000001-0000-4000-a000-000000000c2d",
        startTime: "2026-09-03T10:00:00Z",
        endTime: "2026-09-03T10:01:00Z",
      },
      {
        triggerId: "msg-goal-segment-resume-user",
        triggerText: "Resume the release goal",
        triggerResponse: "The release goal has resumed.",
        triggerRunId: "f0000001-0000-4000-a000-000000000c2e",
        goalInputId: "msg-goal-segment-resume-input",
        goalResponse: "The resumed goal segment finished.",
        goalRunId: "f0000001-0000-4000-a000-000000000c2f",
        startTime: "2026-09-03T10:10:00Z",
        endTime: "2026-09-03T10:11:00Z",
      },
    ];
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Interrupted goal run work folding",
      chatEvents: segments.flatMap((segment) => {
        return [
          {
            id: segment.triggerId,
            role: "user" as const,
            content: segment.triggerText,
            runId: segment.triggerRunId,
            createdAt: segment.startTime,
          },
          {
            id: `${segment.triggerId}-assistant`,
            role: "assistant" as const,
            content: segment.triggerResponse,
            runId: segment.triggerRunId,
            runLifecycleEvent: "completed" as const,
            createdAt: segment.startTime,
          },
          {
            id: segment.goalInputId,
            role: "user" as const,
            content: goalPrompt,
            userMessage: {
              version: 1 as const,
              parts: [{ type: "goal" as const, goalBrief }],
            },
            runId: segment.goalRunId,
            runGroupId,
            createdAt: segment.endTime,
          },
          {
            id: `${segment.goalInputId}-assistant`,
            role: "assistant" as const,
            content: segment.goalResponse,
            runId: segment.goalRunId,
            runGroupId,
            runLifecycleEvent: "completed" as const,
            createdAt: segment.endTime,
          },
        ];
      }),
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatRunWorkFolding]: true,
      },
    });

    await screen.findByText("The resumed goal segment finished.");
    expect(screen.getByText("Start the release goal")).toBeInTheDocument();
    expect(screen.getByText("Resume the release goal")).toBeInTheDocument();
    expect(
      screen.getByText("The first goal segment finished."),
    ).toBeInTheDocument();
    expect(screen.getAllByLabelText("Expand work history")).toHaveLength(2);
    expect(
      screen.queryByText("The release goal has started."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("The release goal has resumed."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(goalBrief)).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText("Expand work history")[1]!);

    await waitFor(() => {
      expect(
        screen.getByText("The release goal has resumed."),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("The release goal has started."),
    ).not.toBeInTheDocument();
  });

  it("keeps merged goal work active while the latest continuation is running", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000025";
    const runGroupId = "f0000001-0000-4000-a000-000000000d2b";
    const goalBrief = "Keep checking the release";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Active goal run work folding",
      chatEvents: [
        {
          id: "msg-active-goal-work-trigger-user",
          role: "user",
          content: "Start checking the release",
          runId: "f0000001-0000-4000-a000-000000000d2c",
          createdAt: "2026-09-03T10:00:00Z",
        },
        {
          id: "msg-active-goal-work-trigger-assistant",
          role: "assistant",
          content: "The release check has started.",
          runId: "f0000001-0000-4000-a000-000000000d2c",
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T10:00:10Z",
        },
        {
          id: "msg-active-goal-work-user-1",
          role: "user",
          content: goalBrief,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-000000000d2d",
          runGroupId,
          createdAt: "2026-09-03T10:01:00Z",
        },
        {
          id: "msg-active-goal-work-assistant-1",
          role: "assistant",
          content: "The first release check passed.",
          runId: "f0000001-0000-4000-a000-000000000d2d",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T10:01:30Z",
        },
        {
          id: "msg-active-goal-work-user-2",
          role: "user",
          content: goalBrief,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-000000000d2e",
          runGroupId,
          createdAt: "2026-09-03T10:02:00Z",
        },
        {
          id: "msg-active-goal-work-thinking-2",
          eventType: "output.thinking",
          role: "assistant",
          content: null,
          thinking: "Checking the next release gate",
          runId: "f0000001-0000-4000-a000-000000000d2e",
          runGroupId,
          createdAt: "2026-09-03T10:02:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatRunWorkFolding]: true,
      },
    });

    const expandWork = await screen.findByLabelText("Expand work history");
    expect(expandWork).toHaveTextContent(/^Working for /);
    expect(screen.getByText("Start checking the release")).toBeInTheDocument();
    expect(
      screen.getByText("The first release check passed."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
    expect(screen.queryByText(goalBrief)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Expand grouped run history"),
    ).not.toBeInTheDocument();
    expect(document.querySelector("[data-thinking-indicator]")).not.toBeNull();
  });

  it("keeps cancelled goal continuations folded with their triggering run", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000026";
    const runGroupId = "f0000001-0000-4000-a000-000000000e2b";
    const goalBrief = "Keep checking the release";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Cancelled goal run work folding",
      chatEvents: [
        {
          id: "msg-cancelled-goal-work-trigger-user",
          role: "user",
          content: "Start checking the release",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Start checking the release" },
              { type: "model", selectedModel: "gpt-5.5" },
            ],
          },
          runId: "f0000001-0000-4000-a000-000000000e2c",
          createdAt: "2026-09-03T10:00:00Z",
        },
        {
          id: "msg-cancelled-goal-work-trigger-assistant",
          role: "assistant",
          content: "The release check has started.",
          runId: "f0000001-0000-4000-a000-000000000e2c",
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T10:00:10Z",
        },
        {
          id: "msg-cancelled-goal-work-user-1",
          role: "user",
          content: goalBrief,
          userMessage: {
            version: 1,
            parts: [
              { type: "goal", goalBrief },
              { type: "model", selectedModel: "gpt-5.5" },
            ],
          },
          runId: "f0000001-0000-4000-a000-000000000e2d",
          runGroupId,
          createdAt: "2026-09-03T10:01:00Z",
        },
        {
          id: "msg-cancelled-goal-work-assistant-1",
          role: "assistant",
          content: "The first release check passed.",
          runId: "f0000001-0000-4000-a000-000000000e2d",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-09-03T10:01:30Z",
        },
        {
          id: "msg-cancelled-goal-work-user-2",
          role: "user",
          content: goalBrief,
          userMessage: {
            version: 1,
            parts: [
              { type: "goal", goalBrief },
              { type: "model", selectedModel: "claude-sonnet-4-6" },
            ],
          },
          runId: "f0000001-0000-4000-a000-000000000e2e",
          runGroupId,
          createdAt: "2026-09-03T10:02:00Z",
        },
        {
          id: "msg-cancelled-goal-work-assistant-2",
          role: "assistant",
          content: "Run cancelled",
          error: "Run cancelled",
          runId: "f0000001-0000-4000-a000-000000000e2e",
          runGroupId,
          runLifecycleEvent: "cancelled",
          createdAt: "2026-09-03T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatRunWorkFolding]: true,
      },
    });

    await screen.findByText("Paused mid-thought — pick it back up whenever.");
    const expandWork = screen.getByLabelText("Expand work history");
    expect(expandWork).toHaveTextContent(/^Worked for /);
    expect(screen.getByText("Start checking the release")).toBeInTheDocument();
    expect(
      screen.queryByText("The release check has started."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("The first release check passed."),
    ).toBeInTheDocument();
    expectTextBefore(
      document.body,
      "The first release check passed.",
      "Paused mid-thought — pick it back up whenever.",
    );
    expect(
      screen.queryByText("Model changed to Claude Sonnet 4.6"),
    ).not.toBeInTheDocument();
    const finalOutputGroup = screen
      .getByText("The first release check passed.")
      .closest<HTMLElement>('[data-role="assistant"]');
    const cancellationGroup = screen
      .getByText("Paused mid-thought — pick it back up whenever.")
      .closest<HTMLElement>('[data-role="assistant"]');
    expect(cancellationGroup).toBe(finalOutputGroup);
    expect(
      within(finalOutputGroup!).getAllByLabelText("View agent profile"),
    ).toHaveLength(1);
    expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
    expect(screen.queryByText(goalBrief)).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Expand grouped run history"),
    ).not.toBeInTheDocument();

    fireEvent.click(expandWork);

    await waitFor(() => {
      expect(
        screen.getByText("The release check has started."),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Model changed to Claude Sonnet 4.6"),
      ).toBeInTheDocument();
    });
    expectTextBefore(
      document.body,
      "The first release check passed.",
      "Model changed to Claude Sonnet 4.6",
    );
    expectTextBefore(
      document.body,
      "Model changed to Claude Sonnet 4.6",
      "Paused mid-thought — pick it back up whenever.",
    );
    expect(screen.queryByText(goalBrief)).not.toBeInTheDocument();
  });

  it("expands archived goal history for an event hash", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000016";
    const runGroupId = "f0000001-0000-4000-a000-00000000092b";
    const goalBrief = "Open the archived goal event";
    const goalPrompt = `${goalBrief}\n\nFull autonomous goal prompt`;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Goal event deep link",
      chatEvents: [
        {
          id: "msg-goal-deep-link-user-1",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-00000000092c",
          runGroupId,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-deep-link-assistant-1",
          role: "assistant",
          content: "Archived goal result",
          runId: "f0000001-0000-4000-a000-00000000092c",
          runGroupId,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-goal-deep-link-user-2",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-00000000092d",
          runGroupId,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-goal-deep-link-assistant-2",
          role: "assistant",
          content: "Latest goal result",
          runId: "f0000001-0000-4000-a000-00000000092d",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}#event-msg-goal-deep-link-assistant-1`,
    });

    await expect(
      screen.findByText("Archived goal result"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Latest goal result")).toBeInTheDocument();
    expect(
      document.querySelector(
        '[data-chat-scroll-anchor-event-id="msg-goal-deep-link-assistant-1"]',
      ),
    ).not.toBeNull();
  });

  it("keeps archived goal history below a running goal without assistant text", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000010";
    const runGroupId = "f0000001-0000-4000-a000-00000000082b";
    const goalBrief = "Migrate legacy automations";
    const goalPrompt = `${goalBrief}

Full autonomous goal prompt that should stay out of the compact chat UI`;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Active goal run group folding",
      chatEvents: [
        {
          id: "msg-goal-run-group-active-user-1",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-00000000082c",
          runGroupId,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-run-group-active-assistant-1",
          role: "assistant",
          content: "First goal result",
          runId: "f0000001-0000-4000-a000-00000000082c",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-goal-run-group-active-user-2",
          role: "user",
          content: goalPrompt,
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief }],
          },
          runId: "f0000001-0000-4000-a000-00000000082d",
          runGroupId,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-goal-run-group-active-thinking-2",
          eventType: "output.thinking",
          role: "assistant",
          content: null,
          thinking: "Sketching the details",
          runId: "f0000001-0000-4000-a000-00000000082d",
          runGroupId,
          createdAt: "2026-06-09T10:02:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Goal")).toBeInTheDocument();
      expect(screen.getByText(goalBrief)).toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        `2 mins for ${goalBrief}`,
      );
      expect(screen.queryByText("First goal result")).not.toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });

    const goalText = screen.getByText(goalBrief);
    const foldButton = buttonByLabel("Expand grouped run history");
    const thinkingIndicator = document.querySelector(
      "[data-thinking-indicator]",
    );

    if (!(thinkingIndicator instanceof HTMLElement)) {
      throw new Error("Thinking indicator not found");
    }
    const waitingAssistantGroup = thinkingIndicator.closest(
      '[data-role="assistant"]',
    );
    if (!(waitingAssistantGroup instanceof HTMLElement)) {
      throw new Error("Waiting assistant group not found");
    }
    expect(waitingAssistantGroup).toContainElement(foldButton);
    const thinkingLabel = within(waitingAssistantGroup).getByLabelText(
      "Sketching the details",
    );
    expect(
      goalText.compareDocumentPosition(foldButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      foldButton.compareDocumentPosition(thinkingLabel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not treat workflow run groups as goals", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000011";
    const runGroupId = "f0000001-0000-4000-a000-00000000073b";
    const workflowPrompt = "/daily-workflow";
    const workflowUserMessage = {
      version: 1 as const,
      parts: [
        {
          type: "automation" as const,
          workflowName: "daily-workflow",
          automationBrief: "Daily workflow summary",
        },
      ],
    };

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Workflow run group folding",
      chatEvents: [
        {
          id: "msg-workflow-run-group-user-1",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000073c",
          runGroupId,
          userMessage: workflowUserMessage,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-run-group-assistant-1",
          role: "assistant",
          content: "First workflow result",
          runId: "f0000001-0000-4000-a000-00000000073c",
          runGroupId,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-workflow-run-group-user-2",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000073d",
          runGroupId,
          userMessage: workflowUserMessage,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-workflow-run-group-assistant-2",
          role: "assistant",
          content: "Latest workflow result",
          runId: "f0000001-0000-4000-a000-00000000073d",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Latest workflow result")).toBeInTheDocument();
      expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "1 run for Daily workflow summary",
      );
      expect(
        screen.queryByText("First workflow result"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps a paused latest workflow run group collapsed by default", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000012";
    const runGroupId = "f0000001-0000-4000-a000-00000000074b";
    const workflowPrompt = "/daily-workflow";
    const workflowUserMessage = {
      version: 1 as const,
      parts: [
        {
          type: "automation" as const,
          workflowName: "daily-workflow",
          automationBrief: "Daily workflow summary",
        },
      ],
    };

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Paused workflow run group",
      chatEvents: [
        {
          id: "msg-paused-workflow-user-1",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000074c",
          runGroupId,
          userMessage: workflowUserMessage,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-paused-workflow-assistant-1",
          role: "assistant",
          content: "First workflow result",
          runId: "f0000001-0000-4000-a000-00000000074c",
          runGroupId,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-paused-workflow-user-2",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000074d",
          runGroupId,
          userMessage: workflowUserMessage,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-paused-workflow-assistant-2",
          role: "assistant",
          content: "Run cancelled",
          error: "Run cancelled",
          runId: "f0000001-0000-4000-a000-00000000074d",
          runGroupId,
          runLifecycleEvent: "cancelled",
          createdAt: "2026-06-09T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(
        screen.queryByText("First workflow result"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "1 run for Daily workflow summary",
      );
    });

    fireEvent.click(buttonByLabel("Expand grouped run history"));

    await waitFor(() => {
      expect(screen.getByText("First workflow result")).toBeInTheDocument();
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
      expect(buttonByLabel("Collapse grouped run history")).toHaveTextContent(
        "1 run for Daily workflow summary",
      );
    });
  });

  it("keeps rendering legacy workflow automation briefs without text", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000013";
    const workflowPrompt = "/daily-workflow";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Workflow user message marker",
      chatEvents: [
        {
          id: "msg-workflow-marker-user",
          eventType: "input.automation",
          content: null,
          runId: "f0000001-0000-4000-a000-00000000083c",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "Daily workflow",
                workflowId: "f0000001-0000-4000-a000-000000000831",
                automationBrief: "Gmail label applied",
              },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-marker-assistant",
          role: "assistant",
          content: "Workflow result",
          runId: "f0000001-0000-4000-a000-00000000083c",
          createdAt: "2026-06-09T10:00:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Workflow Daily workflow"),
      ).toBeInTheDocument();
      expect(screen.getByText("Gmail label applied")).toBeInTheDocument();
      expect(
        screen.queryByText("Daily workflow · Gmail label applied"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(workflowPrompt)).not.toBeInTheDocument();
    });
  });

  it("renders the persisted workflow prompt instead of its brief", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000014";
    const workflowPrompt =
      '/daily-workflow\nTrigger: Gmail applied label "todo" to message msg-123.';

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Workflow user message prompt",
      chatEvents: [
        {
          id: "msg-workflow-prompt-user",
          eventType: "input.automation",
          content: null,
          runId: "f0000001-0000-4000-a000-00000000084c",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: workflowPrompt },
              {
                type: "automation",
                workflowName: "Daily workflow",
                workflowId: "f0000001-0000-4000-a000-000000000841",
                automationBrief: "Gmail label applied",
              },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const annotation = await screen.findByLabelText("Workflow Daily workflow");
    const userTurn = annotation.closest('[data-role="user"]');
    expect(userTurn).not.toBeNull();
    expect(userTurn).toHaveTextContent("/daily-workflow");
    expect(userTurn).toHaveTextContent(
      'Trigger: Gmail applied label "todo" to message msg-123.',
    );
    expect(userTurn).not.toHaveTextContent("Gmail label applied");
  });

  it("renders persisted workflow prompts without a trigger brief", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000015";
    const workflowPrompt =
      '/turbo-flaky-test-repair\nTrigger: GitHub Actions workflow "Turbo" completed with conclusion "failure".';

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Workflow user message without brief",
      chatEvents: [
        {
          id: "msg-workflow-no-brief-user",
          eventType: "input.automation",
          content: null,
          runId: "f0000001-0000-4000-a000-00000000085c",
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: workflowPrompt },
              {
                type: "automation",
                workflowName: "turbo-flaky-test-repair",
              },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const annotation = await screen.findByLabelText(
      "Workflow turbo-flaky-test-repair",
    );
    const userTurn = annotation.closest('[data-role="user"]');
    expect(userTurn).not.toBeNull();
    expect(userTurn).toHaveTextContent("/turbo-flaky-test-repair");
    expect(userTurn).toHaveTextContent(
      'Trigger: GitHub Actions workflow "Turbo" completed with conclusion "failure".',
    );
  });

  it("renders a pending automation only as an automation event", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000016";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Pending automation event",
      chatEvents: [
        {
          id: "msg-claimed-automation",
          eventType: "input.automation",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "daily-workflow",
                automationBrief: "Scheduled digest due",
              },
            ],
          },
          runId: "f0000001-0000-4000-a000-000000000933",
          createdAt: "2026-06-09T09:59:00Z",
        },
        {
          id: "msg-pending-automation",
          eventType: "input.automation",
          content: null,
          userMessage: {
            version: 1,
            parts: [
              {
                type: "automation",
                workflowName: "daily-workflow",
                automationBrief: "Gmail label applied",
              },
            ],
          },
          runId: undefined,
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    const claimedAutomationBrief = await screen.findByText(
      "Scheduled digest due",
    );
    expect(claimedAutomationBrief).toBeInTheDocument();
    await expect(
      screen.findByLabelText("Pending automation event"),
    ).resolves.toHaveTextContent("Gmail label applied");
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
  });

  it("shows template labels on historical user messages", async () => {
    const threadId = "e9000000-0000-4000-a000-000000000017";
    const presentationTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const videoTemplate = VIDEO_TEMPLATE_ITEMS[0]!;
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const websiteTemplate = WEBSITE_TEMPLATE_ITEMS[0]!;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Template labels",
      chatEvents: [
        {
          id: "msg-template-presentation",
          role: "user",
          content: "Create the business review deck",
          runId: "run-template-presentation",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "template",
                titleSnapshot: presentationTemplate.title,
                template: {
                  type: "presentation",
                  selection: {
                    templateId: presentationTemplate.templateId,
                  },
                },
              },
              { type: "text", text: "Create the business review deck" },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-template-video",
          role: "user",
          content: "Create a product walkthrough video",
          runId: "run-template-video",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "template",
                titleSnapshot: videoTemplate.title,
                template: {
                  type: "video",
                  selection: { stylePresetId: videoTemplate.id },
                },
              },
              {
                type: "text",
                text: "Create a product walkthrough video",
              },
            ],
          },
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-template-illustration",
          role: "user",
          content: "Create an illustrated launch card",
          runId: "run-template-illustration",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "template",
                titleSnapshot: illustrationTemplate.title,
                template: {
                  type: "illustration",
                  selection: {
                    illustrationStyleId:
                      illustrationTemplate.illustrationStyleId,
                  },
                },
              },
              { type: "text", text: "Create an illustrated launch card" },
            ],
          },
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-template-website",
          role: "user",
          content: "Create a yoga website",
          runId: "run-template-website",
          userMessage: {
            version: 1,
            parts: [
              {
                type: "template",
                titleSnapshot: websiteTemplate.title,
                template: {
                  type: "website",
                  selection: { websiteTemplateId: websiteTemplate.id },
                },
              },
              { type: "text", text: "Create a yoga website" },
            ],
          },
          createdAt: "2026-06-09T10:03:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      const presentationChip = screen.getByTitle(
        `Presentation · ${presentationTemplate.title}`,
      );
      // A sent video chip appends its parameters to the title when the video
      // options switch is on, so match the prefix rather than the whole title.
      const videoChip = screen.getByTitle((title) => {
        return title.startsWith(`Video · ${videoTemplate.title}`);
      });
      const illustrationChip = screen.getByTitle(
        `Illustration · ${illustrationTemplate.title}`,
      );
      const websiteChip = screen.getByTitle(
        `Website · ${websiteTemplate.title}`,
      );
      expect(presentationChip).toHaveTextContent(presentationTemplate.title);
      expect(videoChip).toHaveTextContent(videoTemplate.title);
      expect(illustrationChip).toHaveTextContent(illustrationTemplate.title);
      expect(websiteChip).toHaveTextContent(websiteTemplate.title);
      // Sent templates are a record of the run, so they stay static text.
      expect(queryAllByRoleFast("button")).not.toContain(videoChip);
    });
  });

  it("copies a canonical user message with rich attachments from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "e9000000-0000-4000-a000-000000000018";
    const messageText = "Review the launch assets";
    const imageUrl = "/f/test-user/attachment-chart/chart.png";
    const videoUrl = "/f/test-user/attachment-demo/demo.mp4";
    const audioUrl = "/f/test-user/attachment-briefing/briefing.mp3";
    const markdownUrl = "/f/test-user/attachment-notes/notes.md";
    const fileFixtures = [
      {
        id: "attachment-chart",
        filename: "chart.png",
        contentType: "image/png",
        size: 1024,
        url: imageUrl,
      },
      {
        id: "attachment-demo",
        filename: "demo.mp4",
        contentType: "video/mp4",
        size: 2048,
        url: videoUrl,
      },
      {
        id: "attachment-briefing",
        filename: "briefing.mp3",
        contentType: "audio/mpeg",
        size: 3072,
        url: audioUrl,
      },
      {
        id: "attachment-notes",
        filename: "notes.md",
        contentType: "text/markdown",
        size: 4096,
        url: markdownUrl,
      },
    ];
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-rich-attachments",
          role: "user",
          content: "stale legacy content",
          userMessage: {
            version: 1,
            parts: [
              ...fileFixtures.map((file) => {
                return {
                  type: "file" as const,
                  fileId: file.id,
                  filenameSnapshot: file.filename,
                  contentType: file.contentType,
                };
              }),
              { type: "text", text: messageText },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(messageText)).toBeInTheDocument();
      expect(screen.getByLabelText("Preview chart.png")).toBeInTheDocument();
      expect(screen.getByLabelText("Preview demo.mp4")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open audio preview for briefing.mp3"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Copy message"));

    const item = await readSingleRichClipboardWrite(clipboard);
    const plainText = await readClipboardItemText(item, "text/plain");
    const canonicalImageUrl = canonicalUserMessageFileUrl("attachment-chart");
    const canonicalVideoUrl = canonicalUserMessageFileUrl("attachment-demo");
    const canonicalAudioUrl = canonicalUserMessageFileUrl(
      "attachment-briefing",
    );
    const canonicalMarkdownUrl =
      canonicalUserMessageFileUrl("attachment-notes");
    expect(plainText).toBe(
      [
        messageText,
        "",
        "Attachments:",
        `- chart.png: ${canonicalImageUrl}`,
        `- demo.mp4: ${canonicalVideoUrl}`,
        `- briefing.mp3: ${canonicalAudioUrl}`,
        `- notes.md: ${canonicalMarkdownUrl}`,
      ].join("\n"),
    );
    const html = await readClipboardItemText(item, "text/html");
    expect(html).toContain("data-vm0-chat-message");
    expect(html).toContain(`<a href="${canonicalImageUrl}"`);
    expect(html).not.toContain("<img");
    const payload = parseChatClipboardPayload(html);
    expect(payload.text).toBe(messageText);
    expect(payload.attachments).toHaveLength(4);
    expect(payload.attachments[0]).toStrictEqual({
      id: "attachment-chart",
      filename: "chart.png",
      url: canonicalImageUrl,
      contentType: "image/png",
      size: 0,
    });
  });

  it("copies text and links for a user message with image attachments from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "e9000000-0000-4000-a000-000000000019";
    const messageText = "Review this image";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-e9000000-0000-4000-a000-000000000019",
          role: "user",
          content: messageText,
          fileParts: [
            {
              type: "file",
              fileId: "attachment-photo",
              filenameSnapshot: "photo.png",
              contentType: "image/png",
            },
          ],
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(messageText)).toBeInTheDocument();
      expect(screen.getByLabelText("Preview photo.png")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Copy message"));

    const item = await readSingleRichClipboardWrite(clipboard);
    const plainText = await readClipboardItemText(item, "text/plain");
    const canonicalImageUrl = canonicalUserMessageFileUrl("attachment-photo");
    expect(plainText).toBe(
      [
        messageText,
        "",
        "Attachments:",
        `- photo.png: ${canonicalImageUrl}`,
      ].join("\n"),
    );
    const html = await readClipboardItemText(item, "text/html");
    expect(html).toContain("data-vm0-chat-message");
    expect(html).toContain(`<a href="${canonicalImageUrl}"`);
    expect(html).not.toContain("<img");
    expect(parseChatClipboardPayload(html)).toStrictEqual({
      text: messageText,
      attachments: [
        {
          id: "attachment-photo",
          filename: "photo.png",
          url: canonicalImageUrl,
          contentType: "image/png",
          size: 0,
        },
      ],
      userMessage: {
        version: 1,
        parts: [
          {
            type: "file",
            fileId: "attachment-photo",
            filenameSnapshot: "photo.png",
            contentType: "image/png",
          },
          { type: "text", text: messageText },
        ],
      },
    });
  });

  it("copies the structured message snapshot instead of stale legacy fields", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "e9000000-0000-4000-a000-000000000020";
    const referencedThreadId = "b0000000-0000-4000-a000-000000000799";
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const firstAttachment = {
      id: "structured-copy-first",
      filename: "first.txt",
      contentType: "text/plain",
      size: 5,
      url: "https://cdn.vm7.io/artifacts/test/copy/first.txt",
    };
    const secondAttachment = {
      id: "structured-copy-second",
      filename: "second.txt",
      contentType: "text/plain",
      size: 6,
      url: "https://cdn.vm7.io/artifacts/test/copy/second.txt",
    };
    const userMessage = {
      version: 1 as const,
      parts: [
        {
          type: "template" as const,
          titleSnapshot: style.title,
          template: {
            type: "illustration" as const,
            selection: {
              illustrationStyleId: style.illustrationStyleId,
            },
          },
        },
        {
          type: "file" as const,
          fileId: secondAttachment.id,
          filenameSnapshot: secondAttachment.filename,
          contentType: secondAttachment.contentType,
        },
        { type: "text" as const, text: "Review " },
        {
          type: "chat_thread" as const,
          threadId: referencedThreadId,
          titleSnapshot: "Roadmap",
        },
        {
          type: "file" as const,
          fileId: firstAttachment.id,
          filenameSnapshot: firstAttachment.filename,
          contentType: firstAttachment.contentType,
        },
        { type: "text" as const, text: " now" },
        {
          type: "feedback" as const,
          quote: "The roadmap lacks dates",
          note: [{ type: "text" as const, text: "Add the launch milestones" }],
        },
      ],
    };
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-structured-copy",
          role: "user",
          content: "stale legacy content",
          userMessage,
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Review")).toBeInTheDocument();
      expect(screen.getByText("Roadmap")).toBeInTheDocument();
      expect(screen.queryByText("stale legacy content")).toBeNull();
    });
    click(screen.getByLabelText("Copy message"));

    const item = await readSingleRichClipboardWrite(clipboard);
    const html = await readClipboardItemText(item, "text/html");
    expect(parseChatClipboardPayload(html)).toStrictEqual({
      // The template part renders inline into the copied prompt text.
      text:
        `Select ${style.title} illustration template` +
        `Review [Roadmap](/chats/${referencedThreadId}) now\n\n` +
        "Feedback on this part of your reply:\n\n" +
        "> The roadmap lacks dates\n\nAdd the launch milestones",
      attachments: [secondAttachment, firstAttachment].map((attachment) => {
        return {
          ...attachment,
          size: 0,
          url: canonicalUserMessageFileUrl(attachment.id),
        };
      }),
      userMessage,
    });
  });

  it("restores a copied structured template when pasting into the composer", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "e9000000-0000-4000-a000-000000000021";
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const selectedTemplate = {
      type: "illustration" as const,
      selection: {
        illustrationStyleId: style.illustrationStyleId,
      },
    };
    const messageText = "Create a matching illustration";
    const feedbackQuote = "The illustration lacks contrast";
    const feedbackNote = "Increase the foreground contrast";
    const userMessage = {
      version: 1 as const,
      parts: [
        {
          type: "template" as const,
          titleSnapshot: style.title,
          template: selectedTemplate,
        },
        { type: "text" as const, text: messageText },
        {
          type: "feedback" as const,
          quote: feedbackQuote,
          note: [{ type: "text" as const, text: feedbackNote }],
        },
      ],
    };
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-e9000000-0000-4000-a000-000000000021",
          role: "user",
          content: "invalidate",
          userMessage,
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText(messageText)).toBeInTheDocument();
    });
    click(screen.getByLabelText("Copy message"));

    const item = await readSingleRichClipboardWrite(clipboard);
    const html = await readClipboardItemText(item, "text/html");
    const plainText = await readClipboardItemText(item, "text/plain");
    const composer = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.paste(composer, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/html"
            ? html
            : type === "text/plain"
              ? plainText
              : "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(composer).toHaveTextContent(messageText);
      expect(
        composer.querySelector("[data-composer-inline-template]"),
      ).toHaveTextContent(style.title);
      const feedbackItem = composer.querySelector("[data-feedback-item]");
      expect(feedbackItem).toHaveTextContent(feedbackQuote);
      expect(feedbackItem).toHaveTextContent(feedbackNote);
    });
  });

  it("preserves structured feedback when the browser rejects the modern clipboard API", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    clipboard.rejectWith(
      new DOMException("Clipboard blocked", "NotAllowedError"),
    );
    const fallbackClipboard = context.mocks.browser.clipboardExecCommand();
    const threadId = "e9000000-0000-4000-a000-000000000022";
    const userMessage = {
      version: 1 as const,
      parts: [
        {
          type: "feedback" as const,
          quote: "The release plan needs an owner",
          note: [{ type: "text" as const, text: "Name the owner" }],
        },
        {
          type: "feedback" as const,
          quote: "The release plan needs dates",
          note: [{ type: "text" as const, text: "Add the milestones" }],
        },
      ],
    };
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-e9000000-0000-4000-a000-000000000022",
          role: "user",
          content: "stale legacy feedback",
          userMessage,
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await screen.findByText("The release plan needs an owner");
    click(screen.getByLabelText("Copy message"));

    await waitFor(() => {
      expect(fallbackClipboard.writes).toHaveLength(1);
    });
    const copied = fallbackClipboard.writes[0];
    if (!copied) {
      throw new Error("Fallback clipboard write not found");
    }
    const composer = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.paste(composer, {
      clipboardData: {
        getData: (type: string) => {
          return copied[type] ?? "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      const feedbackItems = composer.querySelectorAll("[data-feedback-item]");
      expect(feedbackItems).toHaveLength(2);
      expect(feedbackItems[0]).toHaveTextContent(
        "The release plan needs an owner",
      );
      expect(feedbackItems[0]).toHaveTextContent("Name the owner");
      expect(feedbackItems[1]).toHaveTextContent(
        "The release plan needs dates",
      );
      expect(feedbackItems[1]).toHaveTextContent("Add the milestones");
      expect(feedbackItems[0]).toBeVisible();
      expect(feedbackItems[1]).toBeVisible();
    });
  });
});
