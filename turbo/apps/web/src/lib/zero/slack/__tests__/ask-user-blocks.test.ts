import { describe, it, expect } from "vitest";
import type { ActionsBlock, SectionBlock } from "@slack/web-api";
import {
  buildAskUserQuestionBlocks,
  buildAskUserAnsweredBlocks,
} from "../blocks";
import type { AskUserQuestion } from "../blocks";

describe("buildAskUserQuestionBlocks", () => {
  const pendingId = "pending-123";

  it("should build direct-submit buttons for single question single-select", () => {
    const questions: AskUserQuestion[] = [
      {
        question: "Which framework?",
        header: "Framework",
        options: [
          { label: "React", description: "UI library" },
          { label: "Vue" },
        ],
      },
    ];

    const blocks = buildAskUserQuestionBlocks(questions, pendingId);

    // Header + question + buttons = 3 blocks (no submit button, no context)
    expect(blocks).toHaveLength(3);

    // Header block
    expect(blocks[0]).toMatchObject({
      type: "section",
      text: {
        type: "mrkdwn",
        text: expect.stringContaining("needs your input"),
      },
    });

    // Question text
    expect(blocks[1]).toMatchObject({
      type: "section",
      text: { type: "mrkdwn", text: "*Framework:* Which framework?" },
    });

    // Buttons for direct submit
    const actionsBlock = blocks[2] as ActionsBlock;
    expect(actionsBlock.type).toBe("actions");
    expect(actionsBlock.elements).toHaveLength(2);
    expect(actionsBlock.elements[0]).toMatchObject({
      type: "button",
      text: { type: "plain_text", text: "React" },
      action_id: "ask_user_pick_q0_o0",
      value: pendingId,
    });
    expect(actionsBlock.elements[1]).toMatchObject({
      type: "button",
      text: { type: "plain_text", text: "Vue" },
      action_id: "ask_user_pick_q0_o1",
      value: pendingId,
    });
  });

  it("should render checkboxes for multiSelect questions", () => {
    const questions: AskUserQuestion[] = [
      {
        question: "Which features?",
        multiSelect: true,
        options: [
          { label: "Auth", description: "Authentication" },
          { label: "DB" },
          { label: "Cache" },
        ],
      },
    ];

    const blocks = buildAskUserQuestionBlocks(questions, pendingId);

    // Skip header (0) and question text (1), checkboxes at index 2
    const actionsBlock = blocks[2] as ActionsBlock;
    expect(actionsBlock.type).toBe("actions");
    expect(actionsBlock.elements).toHaveLength(1);

    const checkbox = actionsBlock.elements[0];
    expect(checkbox).toMatchObject({
      type: "checkboxes",
      action_id: "ask_user_multi_q0",
    });

    // Verify options have plain_text type
    if (checkbox && "options" in checkbox) {
      const opts = (
        checkbox as {
          options: Array<{ text: { type: string }; value: string }>;
        }
      ).options;
      expect(opts).toHaveLength(3);
      expect(opts[0]?.text.type).toBe("plain_text");
      expect(opts[0]?.value).toBe("q0_o0");
      expect(opts[2]?.value).toBe("q0_o2");
    }
  });

  it("should render checkboxes for multiple single-select questions", () => {
    const questions: AskUserQuestion[] = [
      {
        question: "Framework?",
        options: [{ label: "React" }, { label: "Vue" }],
      },
      {
        question: "Language?",
        options: [{ label: "TS" }, { label: "JS" }],
      },
    ];

    const blocks = buildAskUserQuestionBlocks(questions, pendingId);

    // Header + (question + checkboxes) * 2 + submit + context = 7
    expect(blocks).toHaveLength(7);

    // First question checkboxes
    const q0Actions = blocks[2] as ActionsBlock;
    expect(q0Actions.elements[0]).toMatchObject({
      type: "checkboxes",
      action_id: "ask_user_multi_q0",
    });

    // Second question checkboxes
    const q1Actions = blocks[4] as ActionsBlock;
    expect(q1Actions.elements[0]).toMatchObject({
      type: "checkboxes",
      action_id: "ask_user_multi_q1",
    });

    // Submit button present
    const submitBlock = blocks[5] as ActionsBlock;
    expect(submitBlock.block_id).toBe("ask_user_submit_block");
  });
});

describe("buildAskUserAnsweredBlocks", () => {
  it("should show answered state with selections", () => {
    const questions: AskUserQuestion[] = [
      {
        question: "Framework?",
        header: "Framework",
        options: [{ label: "React" }],
      },
      { question: "Lang?", options: [{ label: "TS" }, { label: "JS" }] },
    ];

    const answers = new Map<number, string[]>();
    answers.set(0, ["React"]);
    answers.set(1, ["TS", "JS"]);

    const blocks = buildAskUserAnsweredBlocks(questions, answers);

    // Context header
    expect(blocks[0]).toMatchObject({
      type: "context",
      elements: [{ type: "mrkdwn", text: expect.stringContaining("Answered") }],
    });

    // First question answer
    const q1 = blocks[1] as SectionBlock;
    expect(q1.text?.text).toContain("*Framework:*");
    expect(q1.text?.text).toContain("React");

    // Second question answer
    const q2 = blocks[2] as SectionBlock;
    expect(q2.text?.text).toContain("TS, JS");
  });

  it("should show no selection for unanswered questions", () => {
    const questions: AskUserQuestion[] = [{ question: "Framework?" }];
    const answers = new Map<number, string[]>();

    const blocks = buildAskUserAnsweredBlocks(questions, answers);

    const q1 = blocks[1] as SectionBlock;
    expect(q1.text?.text).toContain("_No selection_");
  });
});
