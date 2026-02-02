import { describe, it, expect } from "vitest";
import type {
  InputBlock,
  ModalView,
  SectionBlock,
  StaticSelect,
} from "@slack/web-api";
import {
  buildAgentAddModal,
  buildAgentListMessage,
  buildErrorMessage,
  buildLinkAccountMessage,
  buildHelpMessage,
  buildSuccessMessage,
} from "../blocks";

describe("buildAgentAddModal", () => {
  it("should create a valid modal structure", () => {
    const agents = [
      { id: "agent-1", name: "My Coder" },
      { id: "agent-2", name: "My Analyst" },
    ];

    const modal = buildAgentAddModal(agents) as ModalView;

    expect(modal.type).toBe("modal");
    expect(modal.callback_id).toBe("agent_add_modal");
    expect(modal.title).toEqual({ type: "plain_text", text: "Add Agent" });
    expect(modal.submit).toEqual({ type: "plain_text", text: "Add" });
    expect(modal.close).toEqual({ type: "plain_text", text: "Cancel" });
  });

  it("should include agent options in select", () => {
    const agents = [
      { id: "agent-1", name: "My Coder" },
      { id: "agent-2", name: "My Analyst" },
    ];

    const modal = buildAgentAddModal(agents);
    const agentSelectBlock = modal.blocks?.find(
      (b) => "block_id" in b && b.block_id === "agent_select",
    );

    expect(agentSelectBlock).toBeDefined();
    const inputBlock = agentSelectBlock as InputBlock;
    const selectElement = inputBlock.element as StaticSelect;
    const options = selectElement.options;
    expect(options).toHaveLength(2);
    expect(options?.[0]).toEqual({
      text: { type: "plain_text", text: "My Coder" },
      value: "agent-1",
    });
  });
});

describe("buildAgentListMessage", () => {
  it("should show empty state when no bindings", () => {
    const blocks = buildAgentListMessage([]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("don't have any agents"),
      },
    });
  });

  it("should list bindings with status", () => {
    const bindings = [
      {
        agentName: "my-coder",
        description: "Helps with coding",
        enabled: true,
      },
      { agentName: "my-analyst", description: null, enabled: false },
    ];

    const blocks = buildAgentListMessage(bindings);

    // Should have header, divider, and 2 agent sections
    expect(blocks.length).toBeGreaterThanOrEqual(4);

    // Check first agent has checkmark (enabled)
    const firstAgentBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        b.text?.type === "mrkdwn" &&
        b.text.text.includes("my-coder"),
    );
    expect(firstAgentBlock).toBeDefined();
    expect((firstAgentBlock as SectionBlock).text?.text).toContain(
      ":white_check_mark:",
    );

    // Check second agent has X (disabled)
    const secondAgentBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        b.text?.type === "mrkdwn" &&
        b.text.text.includes("my-analyst"),
    );
    expect(secondAgentBlock).toBeDefined();
    expect((secondAgentBlock as SectionBlock).text?.text).toContain(":x:");
  });
});

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

describe("buildLinkAccountMessage", () => {
  it("should create link account message with button", () => {
    const linkUrl = "https://vm0.ai/slack/link?u=U123&w=T456";
    const blocks = buildLinkAccountMessage(linkUrl);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("link your account"),
      },
    });
    expect(blocks[1]).toMatchObject({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Link Account" },
          url: linkUrl,
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
        b.text?.text?.includes("/vm0 agent add"),
    );
    expect(commandsBlock).toBeDefined();

    // Check for usage section
    const usageBlock = blocks.find(
      (b) =>
        b.type === "section" && "text" in b && b.text?.text?.includes("@VM0"),
    );
    expect(usageBlock).toBeDefined();
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
