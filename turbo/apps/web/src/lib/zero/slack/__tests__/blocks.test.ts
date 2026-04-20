import { describe, it, expect } from "vitest";
import type { SectionBlock, ActionsBlock, MarkdownBlock } from "@slack/web-api";
import {
  buildAppHomeView,
  buildErrorMessage,
  buildLoginPromptMessage,
  buildHelpMessage,
  buildSuccessMessage,
  buildAgentResponseMessage,
  buildFooterBlocks,
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
    const commandsBlock = blocks.find((b) => {
      return (
        b.type === "section" &&
        "text" in b &&
        b.text?.text?.includes("/zero connect")
      );
    });
    expect(commandsBlock).toBeDefined();

    // Check for usage section
    const usageBlock = blocks.find((b) => {
      return (
        b.type === "section" && "text" in b && b.text?.text?.includes("@Zero")
      );
    });
    expect(usageBlock).toBeDefined();
  });

  it("should list connect and disconnect commands", () => {
    const blocks = buildHelpMessage();

    const commandsBlock = blocks.find((b) => {
      return (
        b.type === "section" &&
        "text" in b &&
        b.text?.text?.includes("/zero connect")
      );
    });
    expect(commandsBlock).toBeDefined();

    const text = (commandsBlock as SectionBlock).text?.text ?? "";
    expect(text).toContain("Connect to Zero");
    expect(text).toContain("Disconnect from Zero");
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

    const markdownBlock = blocks.find((b) => {
      return b.type === "markdown";
    });
    expect(markdownBlock).toBeDefined();
    expect((markdownBlock as MarkdownBlock).text).toBe("Hello **world**");
  });

  it("should pass raw markdown without conversion", () => {
    const content = "## Header\n\n| Col1 | Col2 |\n|------|------|\n| a | b |";
    const blocks = buildAgentResponseMessage(content);

    const markdownBlock = blocks.find((b) => {
      return b.type === "markdown";
    }) as MarkdownBlock;
    expect(markdownBlock.text).toBe(content);
  });

  it("should include context block with logs url when provided", () => {
    const blocks = buildAgentResponseMessage(
      "Response text",
      "https://app.vm0.ai/audit/123",
    );

    const contextBlock = blocks.find((b) => {
      return b.type === "context";
    });
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

  it("should truncate content exceeding 12000 characters", () => {
    const longContent = "x".repeat(13000);
    const blocks = buildAgentResponseMessage(longContent);

    const markdownBlock = blocks.find((b) => {
      return b.type === "markdown";
    }) as MarkdownBlock;
    expect(markdownBlock.text.length).toBeLessThanOrEqual(12000);
    expect(markdownBlock.text).toContain("Message too long to view in Slack.");
  });

  it("should not truncate content under 12000 characters", () => {
    const content = "x".repeat(11000);
    const blocks = buildAgentResponseMessage(content);

    const markdownBlock = blocks.find((b) => {
      return b.type === "markdown";
    }) as MarkdownBlock;
    expect(markdownBlock.text).toBe(content);
  });

  it("should show triggeredBy as separate context block below audit with divider", () => {
    const blocks = buildAgentResponseMessage(
      "Response text",
      "https://app.vm0.ai/activity/run-123",
      'Triggered by schedule "Send a greeting message daily at 9 AM"',
    );

    // Should have: markdown, audit context, divider, attribution context
    const dividerBlocks = blocks.filter((b) => {
      return b.type === "divider";
    });
    expect(dividerBlocks).toHaveLength(1);

    const contextBlocks = blocks.filter((b) => {
      return b.type === "context";
    });
    expect(contextBlocks).toHaveLength(2);

    // First context: audit link only
    const auditText = (contextBlocks[0] as { elements: { text: string }[] })
      .elements[0]!.text;
    expect(auditText).toContain("Audit");
    expect(auditText).not.toContain("Triggered by");

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

    const contextBlocks = blocks.filter((b) => {
      return b.type === "context";
    });
    expect(contextBlocks).toHaveLength(1);
    expect(
      (contextBlocks[0] as { elements: { text: string }[] }).elements[0]!.text,
    ).toContain("Audit");
  });
});

describe("buildFooterBlocks", () => {
  it("should create divider + context block with given text", () => {
    const blocks = buildFooterBlocks("Sent via my-agent");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("divider");
    expect(blocks[1]!.type).toBe("context");
    expect(
      (blocks[1] as { elements: { text: string }[] }).elements[0]!.text,
    ).toBe("Sent via my-agent");
  });
});

describe("buildAppHomeView", () => {
  it("should show not-installed state with button when isInstalled is false", () => {
    const view = buildAppHomeView({ isLinked: false, isInstalled: false });

    expect(view.type).toBe("home");
    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => {
        return b.type === "section" && "text" in b;
      })
      .map((b) => {
        return b.text?.text ?? "";
      });
    const allText = blockTexts.join(" ");
    expect(allText).toContain("not installed");
    expect(allText).toContain("workspace admin");

    // Should have an actions block with a button
    const actionsBlock = view.blocks.find((b): b is ActionsBlock => {
      return b.type === "actions";
    });
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
      .filter((b): b is SectionBlock => {
        return b.type === "section" && "text" in b;
      })
      .map((b) => {
        return b.text?.text ?? "";
      });
    expect(blockTexts.join(" ")).toContain("Account not connected");
  });

  it("should show connect button when loginUrl is provided", () => {
    const view = buildAppHomeView({
      isLinked: false,
      loginUrl: "https://example.com/connect",
    });

    const actionsBlock = view.blocks.find((b): b is ActionsBlock => {
      return b.type === "actions";
    });
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
      .filter((b): b is SectionBlock => {
        return b.type === "section" && "text" in b;
      })
      .map((b) => {
        return b.text?.text ?? "";
      });
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
      .filter((b): b is SectionBlock => {
        return b.type === "section" && "text" in b;
      })
      .map((b) => {
        return b.text?.text ?? "";
      });
    expect(blockTexts.join(" ")).toContain("MyAgent");
  });

  it("should not include agent/commands sections for not-installed state", () => {
    const view = buildAppHomeView({ isLinked: false, isInstalled: false });

    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => {
        return b.type === "section" && "text" in b;
      })
      .map((b) => {
        return b.text?.text ?? "";
      });
    const allText = blockTexts.join(" ");
    expect(allText).not.toContain("/zero connect");
    expect(allText).not.toContain("Workspace Agent");
  });

  it("should not include agent/commands sections for not-connected state", () => {
    const view = buildAppHomeView({ isLinked: false });

    const blockTexts = view.blocks
      .filter((b): b is SectionBlock => {
        return b.type === "section" && "text" in b;
      })
      .map((b) => {
        return b.text?.text ?? "";
      });
    const allText = blockTexts.join(" ");
    expect(allText).not.toContain("/zero connect");
    expect(allText).not.toContain("Workspace Agent");
  });
});
