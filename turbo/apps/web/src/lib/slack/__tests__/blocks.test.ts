import { describe, it, expect } from "vitest";
import type { SectionBlock } from "@slack/web-api";
import {
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
        b.text?.text?.includes("/vm0 settings"),
    );
    expect(commandsBlock).toBeDefined();

    // Check for usage section
    const usageBlock = blocks.find(
      (b) =>
        b.type === "section" && "text" in b && b.text?.text?.includes("@VM0"),
    );
    expect(usageBlock).toBeDefined();
  });

  it("should list connect, disconnect, and settings commands", () => {
    const blocks = buildHelpMessage();

    const commandsBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        b.text?.text?.includes("/vm0 connect"),
    );
    expect(commandsBlock).toBeDefined();

    const text = (commandsBlock as SectionBlock).text?.text ?? "";
    expect(text).toContain("Connect to VM0");
    expect(text).toContain("Disconnect from VM0");
    expect(text).toContain("/vm0 settings");
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
      "The api key is missing for the model provider",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: ":key:",
      label: "Configure model providers",
      url: `${platformUrl}/settings`,
    });
  });

  it("should detect secrets/variables keywords", () => {
    const links = detectDeepLinks(
      "Error: missing variable DATABASE_URL",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: ":lock:",
      label: "Manage secrets & variables",
      url: `${platformUrl}/settings?tab=secrets-and-variables`,
    });
  });

  it("should detect Slack token keywords", () => {
    const links = detectDeepLinks("SLACK_BOT_TOKEN is not set", platformUrl);
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: ":gear:",
      label: "Slack settings",
      url: `${platformUrl}/settings/slack`,
    });
  });

  it("should detect connector keywords", () => {
    const links = detectDeepLinks(
      "The MCP server connection failed",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      emoji: ":electric_plug:",
      label: "Configure connectors",
      url: `${platformUrl}/settings?tab=connectors`,
    });
  });

  it("should match case-insensitively", () => {
    const links = detectDeepLinks("API_KEY is not configured", platformUrl);
    expect(links).toHaveLength(1);
    expect(links[0]?.label).toBe("Configure model providers");
  });

  it("should deduplicate by path", () => {
    const links = detectDeepLinks(
      "The api key for the model provider is not configured and the apikey is invalid",
      platformUrl,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(`${platformUrl}/settings`);
  });

  it("should return multiple links for different destinations", () => {
    const links = detectDeepLinks(
      "The api key is missing. Also SLACK_BOT_TOKEN is not set and the MCP server is down.",
      platformUrl,
    );
    expect(links).toHaveLength(3);
    const urls = links.map((l) => l.url);
    expect(urls).toContain(`${platformUrl}/settings`);
    expect(urls).toContain(`${platformUrl}/settings/slack`);
    expect(urls).toContain(`${platformUrl}/settings?tab=connectors`);
  });
});
