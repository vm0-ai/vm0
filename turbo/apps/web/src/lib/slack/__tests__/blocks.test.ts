import { describe, it, expect } from "vitest";
import type { SectionBlock, ActionsBlock } from "@slack/web-api";
import {
  buildAppHomeView,
  buildErrorMessage,
  buildLoginPromptMessage,
  buildHelpMessage,
  buildSuccessMessage,
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

describe("detectDeepLinks", () => {
  const platformUrl = "https://platform.vm0.ai";

  it("should return empty array when no keywords match", () => {
    const links = detectDeepLinks(
      "Hello, everything is working fine!",
      platformUrl,
    );
    expect(links).toEqual([]);
  });

  it("should detect provider-related keywords", () => {
    const links = detectDeepLinks(
      "The model provider is not configured",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: "🔑",
      label: "Configure model providers",
      url: `${platformUrl}/zero/settings`,
    });
  });

  it("should detect secrets/variables keywords as connector links", () => {
    const links = detectDeepLinks(
      "Error: missing variable DATABASE_URL",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: "🔌",
      label: "Configure connectors",
      url: `${platformUrl}/zero/meet`,
    });
  });

  it("should detect connector keywords", () => {
    const links = detectDeepLinks(
      "The MCP server connection failed",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: "🔌",
      label: "Configure connectors",
      url: `${platformUrl}/zero/meet`,
    });
  });

  it("should match case-insensitively", () => {
    const links = detectDeepLinks("API_KEY is not configured", platformUrl);
    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe("Configure connectors");
  });

  it("should deduplicate by path", () => {
    const links = detectDeepLinks(
      "The api key is missing and the secret is not configured and the apikey is invalid",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(`${platformUrl}/zero/meet`);
  });

  it("should return multiple links for different destinations", () => {
    const links = detectDeepLinks(
      "The model provider is missing. Also the api key is not set and the MCP server is down.",
      platformUrl,
    );
    expect(links).toHaveLength(2);
    const urls = links.map((l) => l.url);
    expect(urls).toContain(`${platformUrl}/zero/settings`);
    expect(urls).toContain(`${platformUrl}/zero/meet`);
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
    expect("url" in button && button.url).toContain("/zero/works");
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
