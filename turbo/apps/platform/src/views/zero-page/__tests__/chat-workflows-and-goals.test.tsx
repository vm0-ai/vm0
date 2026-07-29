import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
} from "@vm0/core";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import type {
  ChatThreadWorkflowAutomation,
  ZeroWorkflowAutomationUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  createMockWorkflowAutomation,
  setMockWorkflowAutomations,
} from "../../../mocks/handlers/workflow-automations-store.ts";
import { click, fill } from "../../../__tests__/page-helper.ts";
import {
  expectQueuedMessages,
  mockChatLifecycle,
  sendQueuedMessage,
} from "./chat-test-helpers.ts";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../workflow-chat-prompts.ts";
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
  it("renders a rejected goal continuation as a goal artifact without exposing its machine reason", async () => {
    const threadId = "thread-rejected-goal-artifact";
    const objectiveBrief = "Keep the launch moving";
    const machineReason = "internal provider credential id abc123 is invalid";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Rejected goal artifact",
      chatEvents: [
        {
          id: "msg-rejected-goal",
          role: "user",
          eventType: "input.rejected",
          content: objectiveBrief,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: objectiveBrief }],
          },
          error: machineReason,
          goalSnapshot: { objectiveBrief },
          createdAt: "2026-07-29T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Goal")).toBeInTheDocument();
      expect(screen.getByText(objectiveBrief)).toBeInTheDocument();
    });
    expect(screen.queryByText(machineReason)).not.toBeInTheDocument();
    const goalArtifact = screen
      .getByText(objectiveBrief)
      .closest('[data-role="user"]');
    if (!(goalArtifact instanceof HTMLElement)) {
      throw new Error("Expected the rejected goal artifact");
    }
    expect(within(goalArtifact).getByLabelText("Goal")).toBeInTheDocument();
  });

  it("opens run logs from assistant message actions", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "message-run-logs-thread";
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

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("View run logs"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "zero" })).toBeInTheDocument();
      expect(screen.getByText("Steps")).toBeInTheDocument();
    });
  });

  it("copies an assistant response from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const threadId = "assistant-copy-thread";
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
    const threadId = "assistant-message-create-workflow-empty";
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
    const threadId = "assistant-message-create-workflow-draft";
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
      readonly body: ZeroWorkflowAutomationUpdateRequest;
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
      readonly body: ZeroWorkflowAutomationUpdateRequest;
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
      readonly body: ZeroWorkflowAutomationUpdateRequest;
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

  it("folds goal-state markers into the goal row beneath the queued messages", async () => {
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
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: {
            type: "state",
            status: "active",
            objectiveBrief: "Drive the release to merge",
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });
    let pausedGoalThreadId: string | null = null;
    context.mocks.api(
      zeroGoalsContract.pauseForChatThread,
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

    // The goal is the lowest-priority row: it sits after every queued message.
    await sendQueuedMessage(user, "First queued follow-up");
    await expectQueuedMessages(["First queued follow-up"]);
    const goalRow = screen.getByLabelText("Active goal");
    const strip = goalRow.closest('[role="list"]');
    expect(strip).not.toBeNull();
    const rows = within(strip as HTMLElement).getAllByRole("listitem");
    const goalIndex = rows.indexOf(goalRow);
    const queuedIndex = rows.findIndex((row) => {
      return row.getAttribute("aria-label") === "Queued message";
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
    const threadId = "thread-goal-dialog";
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
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: {
            type: "state",
            status: "active",
            objectiveBrief: "Release brief",
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });
    let requestedThreadId: string | null = null;
    context.mocks.api(
      zeroGoalsContract.getForChatThread,
      ({ params, respond }) => {
        requestedThreadId = params.threadId;
        return respond(200, {
          objective: "# Full goal\n\n- Keep **shipping**\n- Review `objective`",
          objectiveBrief: "Release brief",
          status: "active",
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const goalRow = await screen.findByLabelText("Active goal");
    await user.click(within(goalRow).getByLabelText("Open goal details"));

    const dialog = await screen.findByRole("dialog", { name: "Goal" });
    expect(requestedThreadId).toBe(threadId);
    expect(
      within(dialog).getByRole("heading", { name: "Full goal" }),
    ).toBeInTheDocument();
    expect(dialog.querySelector(".wmde-markdown")).not.toBeNull();
  });

  it("hides the goal row once a completion marker folds in", async () => {
    const threadId = "thread-goal-complete";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-goalc-active",
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: {
            type: "state",
            status: "active",
            objectiveBrief: "Drive the release to merge",
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goalc-complete",
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: { type: "state", status: "complete" },
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

  it("surfaces archived goal history in the latest assistant row", async () => {
    const threadId = "thread-goal-run-group-folding";
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
          goalSnapshot: { objectiveBrief: goalBrief },
          runId: "f0000001-0000-4000-a000-00000000072c",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-run-group-assistant-1",
          role: "assistant",
          content: "First goal result",
          runId: "f0000001-0000-4000-a000-00000000072c",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-goal-run-group-user-2",
          role: "user",
          content: goalPrompt,
          goalSnapshot: { objectiveBrief: goalBrief },
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-goal-run-group-assistant-2a",
          role: "assistant",
          content: "Checking the current goal state.",
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:02:10Z",
        },
        {
          id: "msg-goal-run-group-assistant-2b",
          role: "assistant",
          content: "Latest goal result",
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          isGoalRun: true,
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

  it("keeps archived goal history below a running goal without assistant text", async () => {
    const threadId = "thread-goal-run-group-folding-active";
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
          goalSnapshot: { objectiveBrief: goalBrief },
          runId: "f0000001-0000-4000-a000-00000000082c",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-run-group-active-assistant-1",
          role: "assistant",
          content: "First goal result",
          runId: "f0000001-0000-4000-a000-00000000082c",
          runGroupId,
          isGoalRun: true,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-goal-run-group-active-user-2",
          role: "user",
          content: goalPrompt,
          goalSnapshot: { objectiveBrief: goalBrief },
          runId: "f0000001-0000-4000-a000-00000000082d",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:02:00Z",
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

    const goalEvent = screen.getByText(goalBrief);
    const foldButton = buttonByLabel("Expand grouped run history");
    const thinkingIndicator = document.querySelector(
      "[data-thinking-indicator]",
    );

    expect(thinkingIndicator).not.toBeNull();
    expect(
      goalEvent.compareDocumentPosition(foldButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      foldButton.compareDocumentPosition(thinkingIndicator!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("does not treat workflow run groups as goals", async () => {
    const threadId = "thread-workflow-run-group-folding";
    const runGroupId = "f0000001-0000-4000-a000-00000000073b";
    const workflowPrompt = "/daily-workflow";
    const workflowSnapshot = {
      name: "daily-workflow",
      displayName: "Daily workflow",
      description: "Daily workflow summary",
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
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-run-group-assistant-1",
          role: "assistant",
          content: "First workflow result",
          runId: "f0000001-0000-4000-a000-00000000073c",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-workflow-run-group-user-2",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000073d",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-workflow-run-group-assistant-2",
          role: "assistant",
          content: "Latest workflow result",
          runId: "f0000001-0000-4000-a000-00000000073d",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
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
    const threadId = "thread-paused-workflow-run-group";
    const runGroupId = "f0000001-0000-4000-a000-00000000074b";
    const workflowPrompt = "/daily-workflow";
    const workflowSnapshot = {
      name: "daily-workflow",
      displayName: "Daily workflow",
      description: "Daily workflow summary",
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
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-paused-workflow-assistant-1",
          role: "assistant",
          content: "First workflow result",
          runId: "f0000001-0000-4000-a000-00000000074c",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-paused-workflow-user-2",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000074d",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-paused-workflow-assistant-2",
          role: "assistant",
          content: "Run cancelled",
          error: "Run cancelled",
          runId: "f0000001-0000-4000-a000-00000000074d",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
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

  it("renders workflow automation user messages with the workflow title and brief", async () => {
    const threadId = "thread-workflow-user-message-marker";
    const workflowPrompt = "/daily-workflow";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Workflow user message marker",
      chatEvents: [
        {
          id: "msg-workflow-marker-user",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000083c",
          triggerSource: "workflow-event",
          workflowSnapshot: {
            id: "f0000001-0000-4000-a000-000000000831",
            agentId: "c0000000-0000-4000-a000-000000000001",
            name: "daily-workflow",
            displayName: "Daily workflow",
            description: "Daily workflow summary",
            automationId: "f0000001-0000-4000-a000-000000000832",
            triggerBrief: "Gmail label applied",
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-marker-assistant",
          role: "assistant",
          content: "Workflow result",
          runId: "f0000001-0000-4000-a000-00000000083c",
          triggerSource: "workflow-event",
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

  it("renders a pending automation only as an automation event", async () => {
    const threadId = "thread-pending-automation-event";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Pending automation event",
      chatEvents: [
        {
          id: "msg-claimed-automation",
          eventType: "input.automation",
          content: null,
          automationId: "f0000001-0000-4000-a000-000000000931",
          triggerSource: "workflow-event",
          triggerBrief: "Scheduled digest due",
          runId: "f0000001-0000-4000-a000-000000000933",
          createdAt: "2026-06-09T09:59:00Z",
        },
        {
          id: "msg-pending-automation",
          eventType: "input.automation",
          content: null,
          automationId: "f0000001-0000-4000-a000-000000000932",
          triggerSource: "workflow-event",
          triggerBrief: "Gmail label applied",
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
    const threadId = "template-message-history";
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
      const presentationTemplateLabel = screen.getByLabelText(
        `Message template ${presentationTemplate.title}`,
      );
      const videoTemplateLabel = screen.getByLabelText(
        `Message template ${videoTemplate.title}`,
      );
      const illustrationTemplateLabel = screen.getByLabelText(
        `Message template ${illustrationTemplate.title}`,
      );
      const websiteTemplateLabel = screen.getByLabelText(
        `Message template ${websiteTemplate.title}`,
      );
      expect(presentationTemplateLabel).toHaveTextContent(
        presentationTemplate.title,
      );
      expect(presentationTemplateLabel).toHaveAttribute(
        "title",
        `Presentation · ${presentationTemplate.title}`,
      );
      expect(videoTemplateLabel).toHaveTextContent(videoTemplate.title);
      expect(videoTemplateLabel).toHaveAttribute(
        "title",
        `Video · ${videoTemplate.title}`,
      );
      expect(illustrationTemplateLabel).toHaveTextContent(
        illustrationTemplate.title,
      );
      expect(illustrationTemplateLabel).toHaveAttribute(
        "title",
        `Illustration · ${illustrationTemplate.title}`,
      );
      expect(websiteTemplateLabel).toHaveTextContent(websiteTemplate.title);
      expect(websiteTemplateLabel).toHaveAttribute(
        "title",
        `Website · ${websiteTemplate.title}`,
      );
      expect(
        screen.getByLabelText(`Message template ${videoTemplate.title}`),
      ).toHaveAttribute("aria-haspopup", "dialog");
    });
  });

  it("copies a canonical user message with rich attachments from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "rich-attachment-copy";
    const messageText = "Review the launch assets";
    const imageUrl = "/f/test-user/attachment-chart/chart.png";
    const videoUrl = "/f/test-user/attachment-demo/demo.mp4";
    const audioUrl = "/f/test-user/attachment-briefing/briefing.mp3";
    const markdownUrl = "/f/test-user/attachment-notes/notes.md";
    const attachFiles = [
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
          attachFiles,
          userMessage: {
            version: 1,
            parts: [
              ...attachFiles.map((file) => {
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
    expect(plainText).toBe(
      [
        messageText,
        "",
        "Attachments:",
        `- chart.png: ${imageUrl}`,
        `- demo.mp4: ${videoUrl}`,
        `- briefing.mp3: ${audioUrl}`,
        `- notes.md: ${markdownUrl}`,
      ].join("\n"),
    );
    const html = await readClipboardItemText(item, "text/html");
    expect(html).toContain("data-vm0-chat-message");
    expect(html).toContain(`<a href="${imageUrl}"`);
    expect(html).not.toContain("<img");
    const payload = parseChatClipboardPayload(html);
    expect(payload.text).toBe(messageText);
    expect(payload.attachments).toHaveLength(4);
    expect(payload.attachments[0]).toStrictEqual({
      id: "attachment-chart",
      filename: "chart.png",
      url: imageUrl,
      contentType: "image/png",
      size: 1024,
    });
  });

  it("copies text and links for a user message with image attachments from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "image-attachment-copy";
    const messageText = "Review this image";
    const imageUrl = "https://cdn.vm7.io/artifacts/test/photo/photo.png";
    mockChatLifecycle(context, {
      threadId,
      chatEvents: [
        {
          id: "msg-image-attachment-copy",
          role: "user",
          content: messageText,
          attachFiles: [
            {
              id: "attachment-photo",
              filename: "photo.png",
              contentType: "image/png",
              size: 2048,
              url: imageUrl,
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
    expect(plainText).toBe(
      [messageText, "", "Attachments:", `- photo.png: ${imageUrl}`].join("\n"),
    );
    const html = await readClipboardItemText(item, "text/html");
    expect(html).toContain("data-vm0-chat-message");
    expect(html).toContain(`<a href="${imageUrl}"`);
    expect(html).not.toContain("<img");
    expect(parseChatClipboardPayload(html)).toStrictEqual({
      text: messageText,
      attachments: [
        {
          id: "attachment-photo",
          filename: "photo.png",
          url: imageUrl,
          contentType: "image/png",
          size: 2048,
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
    const threadId = "structured-message-copy";
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
          attachFiles: [firstAttachment, secondAttachment],
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
      text:
        `Review [Roadmap](/chats/${referencedThreadId}) now\n\n` +
        "Feedback on this part of your reply:\n\n" +
        "> The roadmap lacks dates\n\nAdd the launch milestones",
      attachments: [secondAttachment, firstAttachment],
      userMessage,
    });
  });

  it("restores a copied structured template when pasting into the composer", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "structured-template-copy-paste";
    const style = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const generationTemplate = {
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
          template: generationTemplate,
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
          id: "msg-structured-template-copy-paste",
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
        screen.getByLabelText(`Remove template ${style.title}`),
      ).toBeInTheDocument();
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
    const threadId = "structured-feedback-copy-fallback";
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
          id: "msg-structured-feedback-copy-fallback",
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
