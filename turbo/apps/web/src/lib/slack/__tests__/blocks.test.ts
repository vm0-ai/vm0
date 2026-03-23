import { describe, it, expect } from "vitest";
import type { SectionBlock, ActionsBlock, MarkdownBlock } from "@slack/web-api";
import {
  buildAppHomeView,
  buildErrorMessage,
  buildLoginPromptMessage,
  buildHelpMessage,
  buildSuccessMessage,
  buildAgentResponseMessage,
  detectDeepLinks,
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

  it("should include context block with logs url when provided", () => {
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
          text: expect.stringContaining("Audit"),
        },
      ],
    });
  });

  it("should include deep link context blocks when provided", () => {
    const deepLinks = [
      {
        emoji: "\u{1F511}",
        label: "Configure providers",
        url: "https://app.vm0.ai/settings",
      },
    ];
    const blocks = buildAgentResponseMessage(
      "Response text",
      undefined,
      deepLinks,
    );

    const contextBlock = blocks.find((b) => b.type === "context");
    expect(contextBlock).toBeDefined();
    expect(contextBlock).toMatchObject({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: expect.stringContaining("Configure providers"),
        },
      ],
    });
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
});

describe("detectDeepLinks", () => {
  const appUrl = "https://app.vm0.ai";

  it("should return empty array when no keywords match", () => {
    const links = detectDeepLinks("Hello, everything is working fine!", appUrl);
    expect(links).toEqual([]);
  });

  it("should not detect provider-related keywords (handled via error code)", () => {
    const links = detectDeepLinks(
      "The model provider is not configured",
      appUrl,
    );
    expect(links).toEqual([]);
  });

  it("should route connector links to team page with agent name", () => {
    const links = detectDeepLinks(
      "Error: missing variable DATABASE_URL",
      appUrl,
      "my-agent",
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: "\u{1F50C}",
      label: "Configure connectors",
      url: `${appUrl}/team/my-agent?tab=connectors`,
    });
  });

  it("should route connector links to generic team page without agent name", () => {
    const links = detectDeepLinks("The MCP server connection failed", appUrl);
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: "\u{1F50C}",
      label: "Configure connectors",
      url: `${appUrl}/team`,
    });
  });

  it("should match case-insensitively", () => {
    const links = detectDeepLinks(
      "API_KEY is not configured",
      appUrl,
      "test-agent",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe("Configure connectors");
  });

  it("should deduplicate by path", () => {
    const links = detectDeepLinks(
      "The api key is missing and the secret is not configured and the apikey is invalid",
      appUrl,
      "my-agent",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(`${appUrl}/team/my-agent?tab=connectors`);
  });

  it("should only return connector link when both provider and connector keywords present", () => {
    const links = detectDeepLinks(
      "The model provider is missing. Also the api key is not set and the MCP server is down.",
      appUrl,
      "my-agent",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(`${appUrl}/team/my-agent?tab=connectors`);
  });

  it("should encode special characters in agent name", () => {
    const links = detectDeepLinks(
      "connector not found",
      appUrl,
      "agent with spaces",
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(
      `${appUrl}/team/agent%20with%20spaces?tab=connectors`,
    );
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
