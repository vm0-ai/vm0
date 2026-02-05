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
  buildLoginPromptMessage,
  buildHelpMessage,
  buildSuccessMessage,
} from "../blocks";

describe("buildAgentAddModal", () => {
  it("should create a valid modal structure", () => {
    const agents = [
      {
        id: "agent-1",
        name: "My Coder",
        requiredSecrets: [],
        existingSecrets: [],
        requiredVars: [],
        existingVars: [],
      },
      {
        id: "agent-2",
        name: "My Analyst",
        requiredSecrets: [],
        existingSecrets: [],
        requiredVars: [],
        existingVars: [],
      },
    ];

    // Without selected agent, submit button is not shown
    const modalWithoutSelection = buildAgentAddModal(agents) as ModalView;
    expect(modalWithoutSelection.type).toBe("modal");
    expect(modalWithoutSelection.callback_id).toBe("agent_add_modal");
    expect(modalWithoutSelection.title).toEqual({
      type: "plain_text",
      text: "Add Agent",
    });
    // Submit button is always shown (required for input blocks)
    expect(modalWithoutSelection.submit).toEqual({
      type: "plain_text",
      text: "Add",
    });
    expect(modalWithoutSelection.close).toEqual({
      type: "plain_text",
      text: "Cancel",
    });

    // With selected agent, submit button is shown
    const modalWithSelection = buildAgentAddModal(
      agents,
      "agent-1",
    ) as ModalView;
    expect(modalWithSelection.submit).toEqual({
      type: "plain_text",
      text: "Add",
    });
  });

  it("should include agent options in select", () => {
    const agents = [
      {
        id: "agent-1",
        name: "My Coder",
        requiredSecrets: [],
        existingSecrets: [],
        requiredVars: [],
        existingVars: [],
      },
      {
        id: "agent-2",
        name: "My Analyst",
        requiredSecrets: [],
        existingSecrets: [],
        requiredVars: [],
        existingVars: [],
      },
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

  it("should mark existing secrets as optional with checkmark", () => {
    const agents = [
      {
        id: "agent-1",
        name: "My Coder",
        requiredSecrets: ["API_KEY", "NEW_SECRET"],
        existingSecrets: ["API_KEY"],
        requiredVars: [],
        existingVars: [],
      },
    ];

    const modal = buildAgentAddModal(agents, "agent-1") as ModalView;

    // Find the existing secret input (API_KEY)
    const existingSecretBlock = modal.blocks?.find(
      (b) => "block_id" in b && b.block_id === "secret_API_KEY",
    ) as InputBlock;
    expect(existingSecretBlock).toBeDefined();
    expect(existingSecretBlock.optional).toBe(true);
    expect(existingSecretBlock.label).toMatchObject({
      type: "plain_text",
      text: "API_KEY ✓",
    });
    expect(existingSecretBlock.hint).toMatchObject({
      type: "plain_text",
      text: "Already configured in your account",
    });

    // Find the new secret input (NEW_SECRET)
    const newSecretBlock = modal.blocks?.find(
      (b) => "block_id" in b && b.block_id === "secret_NEW_SECRET",
    ) as InputBlock;
    expect(newSecretBlock).toBeDefined();
    expect(newSecretBlock.optional).toBeUndefined();
    expect(newSecretBlock.label).toMatchObject({
      type: "plain_text",
      text: "NEW_SECRET",
    });
    expect(newSecretBlock.hint).toBeUndefined();
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
        text: expect.stringContaining("don't have any agent linked"),
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

describe("buildLoginPromptMessage", () => {
  it("should create login message with button", () => {
    const loginUrl = "https://vm0.ai/slack/link?u=U123&w=T456";
    const blocks = buildLoginPromptMessage(loginUrl);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("login"),
      },
    });
    expect(blocks[1]).toMatchObject({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Login" },
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

    // Check for commands section (now uses link/unlink instead of add/remove)
    const commandsBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        b.text?.text?.includes("/vm0 agent link"),
    );
    expect(commandsBlock).toBeDefined();

    // Check for usage section
    const usageBlock = blocks.find(
      (b) =>
        b.type === "section" && "text" in b && b.text?.text?.includes("@VM0"),
    );
    expect(usageBlock).toBeDefined();
  });

  it("should use 'Log in' and 'Log out' descriptions for login/logout commands", () => {
    const blocks = buildHelpMessage();

    // Find the account section
    const accountBlock = blocks.find(
      (b) =>
        b.type === "section" &&
        "text" in b &&
        b.text?.text?.includes("/vm0 login"),
    );
    expect(accountBlock).toBeDefined();

    const text = (accountBlock as SectionBlock).text?.text ?? "";
    // Should use "Log in to VM0" not "Link your VM0 account"
    expect(text).toContain("Log in to VM0");
    expect(text).toContain("Log out of VM0");
    // Should NOT contain old descriptions
    expect(text).not.toContain("Link your VM0 account");
    expect(text).not.toContain("Unlink your account");
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
