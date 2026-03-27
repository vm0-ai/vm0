import { describe, it, expect } from "vitest";
import type { SectionBlock, ActionsBlock, MarkdownBlock } from "@slack/web-api";
import {
  buildAppHomeView,
  buildErrorMessage,
  buildLoginPromptMessage,
  buildHelpMessage,
  buildSuccessMessage,
  buildAgentResponseMessage,
  buildAuditEphemeralBlocks,
} from "../blocks";

describe("buildErrorMessage", () => {
  it("should create error message block", () => {
    const blocks = buildErrorMessage("Something went wrong");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("Something went wrong"),
      },
    });
    expect((blocks[0] as SectionBlock).text?.text).toContain(":x:");
  });
});

describe("buildLoginPromptMessage", () => {
  it("should create login message with button", () => {
    const loginUrl = "https://vm0.ai/slack/connect?u=U123&w=T456";
    const blocks = buildLoginPromptMessage(loginUrl);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("connect your account"),
      },
    });
    expect(blocks[1]).toMatchObject({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Connect" },
          url: loginUrl,
          style: "primary",
        },
      ],
    });
  });
});

describe("buildHelpMessage", () => {
  it("should include commands and usage sections", () => {
    const blocks = buildHelpMessage();

    expect(blocks.length).toBeGreaterThanOrEqual(3);

    // Check for commands section
    const commandsBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        b.text?.text?.includes("/zero settings"),
    );
    expect(commandsBlock).toBeDefined();

    // Check for usage section
    const usageBlock = blocks.find(
      (b) =>
        b.type === "section" && "text" in b && b.text?.text?.includes("@Zero"),
    );
    expect(usageBlock).toBeDefined();
  });

  it("should list connect, disconnect, and settings commands", () => {
    const blocks = buildHelpMessage();

    const commandsBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        b.text?.text?.includes("/zero connect"),
    );
    expect(commandsBlock).toBeDefined();

    const text = (commandsBlock as SectionBlock).text?.text ?? "";
    expect(text).toContain("Connect to Zero");
    expect(text).toContain("Disconnect from Zero");
    expect(text).toContain("/zero settings");
  });
});

describe("buildSuccessMessage", () => {
  it("should create success message block", () => {
    const blocks = buildSuccessMessage("Agent added successfully");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("Agent added successfully"),
      },
    });
    expect((blocks[0] as SectionBlock).text?.text).toContain(
      ":white_check_mark:",
    );
  });
});

describe("buildAgentResponseMessage", () => {
  it("should use markdown block type for agent content", () => {
    const blocks = buildAgentResponseMessage("Hello **world**");

    const markdownBlock = blocks.find((b) => b.type === "markdown");
    expect(markdownBlock).toBeDefined();
    expect((markdownBlock as MarkdownBlock).text).toBe("Hello **world**");
  });

  it("should pass raw markdown without conversion", () => {
    const content = "## Header\n\n| Col1 | Col2 |\n|------|------|\n| a | b |";
    const blocks = buildAgentResponseMessage(content);

    const markdownBlock = blocks.find(
      (b) => b.type === "markdown",
    ) as MarkdownBlock;
    expect(markdownBlock.text).toBe(content);
  });

  it("should include context block with dashboard link when logsUrl provided", () => {
    const blocks = buildAgentResponseMessage(
      "Response text",
      "https://app.vm0.ai/audit/123",
    );

    const contextBlock = blocks.find((b) => b.type === "context");
    expect(contextBlock).toBeDefined();
    expect(contextBlock).toMatchObject({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: expect.stringContaining("View in dashboard"),
        },
      ],
    });
  });

  it("should include audit button when runId provided", () => {
    const blocks = buildAgentResponseMessage(
      "Response text",
      "https://app.vm0.ai/activity/run-123",
      undefined,
      "run-123",
    );

    const actionsBlock = blocks.find((b) => b.type === "actions");
    expect(actionsBlock).toBeDefined();

    const button = (
      actionsBlock as { elements: { action_id: string; value: string }[] }
    ).elements[0]!;
    expect(button.action_id).toBe("audit_run");
    expect(button.value).toBe("run-123");

    const contextBlock = blocks.find((b) => b.type === "context");
    expect(contextBlock).toBeDefined();
  });

  it("should truncate content exceeding 12000 characters", () => {
    const longContent = "x".repeat(13000);
    const blocks = buildAgentResponseMessage(longContent);

    const markdownBlock = blocks.find(
      (b) => b.type === "markdown",
    ) as MarkdownBlock;
    expect(markdownBlock.text.length).toBeLessThanOrEqual(12000);
    expect(markdownBlock.text).toContain("truncated");
  });

  it("should not truncate content under 12000 characters", () => {
    const content = "x".repeat(11000);
    const blocks = buildAgentResponseMessage(content);

    const markdownBlock = blocks.find(
      (b) => b.type === "markdown",
    ) as MarkdownBlock;
    expect(markdownBlock.text).toBe(content);
  });

  it("should show triggeredBy as separate context block below dashboard link with divider", () => {
    const blocks = buildAgentResponseMessage(
      "Response text",
      "https://app.vm0.ai/activity/run-123",
      'Triggered by schedule "Send a greeting message daily at 9 AM"',
    );

    // Should have: markdown, dashboard context, divider, attribution context
    const dividerBlocks = blocks.filter((b) => b.type === "divider");
    expect(dividerBlocks).toHaveLength(1);

    const contextBlocks = blocks.filter((b) => b.type === "context");
    expect(contextBlocks).toHaveLength(2);

    // First context: dashboard link only
    const dashboardText = (contextBlocks[0] as { elements: { text: string }[] })
      .elements[0]!.text;
    expect(dashboardText).toContain("View in dashboard");
    expect(dashboardText).not.toContain("triggered by");

    // Second context: attribution (after divider)
    const attrText = (contextBlocks[1] as { elements: { text: string }[] })
      .elements[0]!.text;
    expect(attrText).toBe(
      'Triggered by schedule "Send a greeting message daily at 9 AM"',
    );
  });

  it("should not add attribution block when triggeredBy is not provided", () => {
    const blocks = buildAgentResponseMessage(
      "Response text",
      "https://app.vm0.ai/activity/run-123",
    );

    const contextBlocks = blocks.filter((b) => b.type === "context");
    expect(contextBlocks).toHaveLength(1);
    expect(
      (contextBlocks[0] as { elements: { text: string }[] }).elements[0]!.text,
    ).toContain("View in dashboard");
  });
});

describe("buildAuditEphemeralBlocks", () => {
  it("should include header, status, timing, prompt, and dashboard link", () => {
    const blocks = buildAuditEphemeralBlocks({
      runId: "run-123",
      status: "completed",
      prompt: "Summarize the document",
      createdAt: "2026-03-27T10:00:00Z",
      startedAt: "2026-03-27T10:00:01Z",
      completedAt: "2026-03-27T10:00:30Z",
      logsUrl: "https://app.vm0.ai/activity/run-123",
    });

    const header = blocks.find((b) => b.type === "header");
    expect(header).toBeDefined();

    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThanOrEqual(2);

    // Status section
    const statusSection = sections[0] as SectionBlock;
    expect(statusSection.text?.text).toContain("completed");
    expect(statusSection.text?.text).toContain(":white_check_mark:");

    // Prompt section
    const promptSection = sections.find((s) =>
      (s as SectionBlock).text?.text?.includes("Prompt"),
    );
    expect(promptSection).toBeDefined();

    // Dashboard link
    const contextBlocks = blocks.filter((b) => b.type === "context");
    expect(contextBlocks.length).toBeGreaterThanOrEqual(1);
    const lastContext = contextBlocks[contextBlocks.length - 1] as {
      elements: { text: string }[];
    };
    expect(lastContext.elements[0]!.text).toContain("View full details");
  });

  it("should show error section for failed runs", () => {
    const blocks = buildAuditEphemeralBlocks({
      runId: "run-456",
      status: "failed",
      prompt: "Do something",
      error: "Sandbox timeout",
      createdAt: "2026-03-27T10:00:00Z",
      logsUrl: "https://app.vm0.ai/activity/run-456",
    });

    const errorSection = blocks.find(
      (b) =>
        b.type === "section" &&
        (b as SectionBlock).text?.text?.includes("Error"),
    );
    expect(errorSection).toBeDefined();
    expect((errorSection as SectionBlock).text?.text).toContain(
      "Sandbox timeout",
    );
  });

  it("should show output section when output provided", () => {
    const blocks = buildAuditEphemeralBlocks({
      runId: "run-789",
      status: "completed",
      prompt: "Hello",
      output: "Here is the result",
      createdAt: "2026-03-27T10:00:00Z",
      logsUrl: "https://app.vm0.ai/activity/run-789",
    });

    const outputSection = blocks.find(
      (b) =>
        b.type === "section" &&
        (b as SectionBlock).text?.text?.includes("Output"),
    );
    expect(outputSection).toBeDefined();
    expect((outputSection as SectionBlock).text?.text).toContain(
      "Here is the result",
    );
  });

  it("should show duration when both startedAt and completedAt provided", () => {
    const blocks = buildAuditEphemeralBlocks({
      runId: "run-dur",
      status: "completed",
      prompt: "Test",
      createdAt: "2026-03-27T10:00:00Z",
      startedAt: "2026-03-27T10:00:00Z",
      completedAt: "2026-03-27T10:01:30Z",
      logsUrl: "https://app.vm0.ai/activity/run-dur",
    });

    const sections = blocks.filter((b) => b.type === "section");
    const timingText = sections
      .map((s) => (s as SectionBlock).text?.text ?? "")
      .join("\n");
    expect(timingText).toContain("Duration");
    expect(timingText).toContain("1m 30s");
  });

  it("should truncate long prompts", () => {
    const longPrompt = "x".repeat(2000);
    const blocks = buildAuditEphemeralBlocks({
      runId: "run-trunc",
      status: "completed",
      prompt: longPrompt,
      createdAt: "2026-03-27T10:00:00Z",
      logsUrl: "https://app.vm0.ai/activity/run-trunc",
    });

    const promptSection = blocks.find(
      (b) =>
        b.type === "section" &&
        (b as SectionBlock).text?.text?.includes("Prompt"),
    );
    const text = (promptSection as SectionBlock).text?.text ?? "";
    expect(text.length).toBeLessThan(2100);
    expect(text).toContain("...");
  });
});

describe("buildAppHomeView", () => {
  it("should show not-installed state with button when isInstalled is false", () => {
    const view = buildAppHomeView({ isLinked: false, isInstalled: false });

    expect(view.type).toBe("home");
    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => b.type === "section" && "text" in b)
      .map((b) => b.text?.text ?? "");
    const allText = blockTexts.join(" ");
    expect(allText).toContain("not installed");
    expect(allText).toContain("workspace admin");

    // Should have an actions block with a button
    const actionsBlock = view.blocks.find(
      (b): b is ActionsBlock => b.type === "actions",
    );
    expect(actionsBlock).toBeDefined();
    const button = actionsBlock!.elements[0]!;
    expect(button).toMatchObject({
      type: "button",
      text: { type: "plain_text", text: "Open Zero Settings" },
      style: "primary",
    });
    expect("url" in button && button.url).toContain("/works");
  });

  it("should show not-connected state when isLinked is false and isInstalled is not false", () => {
    const view = buildAppHomeView({ isLinked: false });

    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => b.type === "section" && "text" in b)
      .map((b) => b.text?.text ?? "");
    expect(blockTexts.join(" ")).toContain("Account not connected");
  });

  it("should show connect button when loginUrl is provided", () => {
    const view = buildAppHomeView({
      isLinked: false,
      loginUrl: "https://example.com/connect",
    });

    const actionsBlock = view.blocks.find(
      (b): b is ActionsBlock => b.type === "actions",
    );
    expect(actionsBlock).toBeDefined();
    const button = actionsBlock!.elements[0]!;
    expect(button).toMatchObject({
      type: "button",
      text: { type: "plain_text", text: "Connect" },
    });
    expect("url" in button && button.url).toBe("https://example.com/connect");
  });

  it("should show connected state with user info", () => {
    const view = buildAppHomeView({
      isLinked: true,
      userEmail: "user@test.com",
      vm0UserId: "user-123",
    });

    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => b.type === "section" && "text" in b)
      .map((b) => b.text?.text ?? "");
    const allText = blockTexts.join(" ");
    expect(allText).toContain("Connected to Zero");
    expect(allText).toContain("user@test.com");
  });

  it("should show agent name when provided", () => {
    const view = buildAppHomeView({
      isLinked: true,
      agentName: "MyAgent",
      vm0UserId: "user-123",
    });

    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => b.type === "section" && "text" in b)
      .map((b) => b.text?.text ?? "");
    expect(blockTexts.join(" ")).toContain("MyAgent");
  });

  it("should not include agent/commands sections for not-installed state", () => {
    const view = buildAppHomeView({ isLinked: false, isInstalled: false });

    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => b.type === "section" && "text" in b)
      .map((b) => b.text?.text ?? "");
    const allText = blockTexts.join(" ");
    expect(allText).not.toContain("/zero connect");
    expect(allText).not.toContain("Workspace Agent");
  });

  it("should not include agent/commands sections for not-connected state", () => {
    const view = buildAppHomeView({ isLinked: false });

    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => b.type === "section" && "text" in b)
      .map((b) => b.text?.text ?? "");
    const allText = blockTexts.join(" ");
    expect(allText).not.toContain("/zero connect");
    expect(allText).not.toContain("Workspace Agent");
  });
});
