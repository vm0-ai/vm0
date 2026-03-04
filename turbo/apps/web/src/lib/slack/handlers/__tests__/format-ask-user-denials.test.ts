import { describe, it, expect } from "vitest";
import { formatAskUserDenials } from "../run-agent";

describe("formatAskUserDenials", () => {
  it("should format a single question without options", () => {
    const result = formatAskUserDenials([
      {
        tool_input: {
          questions: [{ question: "Which database should I use?" }],
        },
      },
    ]);

    expect(result).toBe(
      "The agent needs your input to proceed:\n\nWhich database should I use?",
    );
  });

  it("should format a question with options", () => {
    const result = formatAskUserDenials([
      {
        tool_input: {
          questions: [
            {
              question: "Which framework do you prefer?",
              options: [
                { label: "React", description: "A UI library" },
                { label: "Vue", description: "A progressive framework" },
              ],
            },
          ],
        },
      },
    ]);

    expect(result).toContain("Which framework do you prefer?");
    expect(result).toContain("  \u2022 React \u2014 A UI library");
    expect(result).toContain("  \u2022 Vue \u2014 A progressive framework");
  });

  it("should format options without descriptions", () => {
    const result = formatAskUserDenials([
      {
        tool_input: {
          questions: [
            {
              question: "Pick one:",
              options: [{ label: "Option A" }, { label: "Option B" }],
            },
          ],
        },
      },
    ]);

    expect(result).toContain("  \u2022 Option A");
    expect(result).toContain("  \u2022 Option B");
    expect(result).not.toContain("\u2014");
  });

  it("should format multiple questions from a single denial", () => {
    const result = formatAskUserDenials([
      {
        tool_input: {
          questions: [
            { question: "First question?" },
            { question: "Second question?" },
          ],
        },
      },
    ]);

    expect(result).toContain("First question?");
    expect(result).toContain("Second question?");
  });

  it("should format multiple denials", () => {
    const result = formatAskUserDenials([
      {
        tool_input: {
          questions: [{ question: "Question from denial 1" }],
        },
      },
      {
        tool_input: {
          questions: [{ question: "Question from denial 2" }],
        },
      },
    ]);

    expect(result).toContain("Question from denial 1");
    expect(result).toContain("Question from denial 2");
  });

  it("should return undefined for empty denials array", () => {
    const result = formatAskUserDenials([]);
    expect(result).toBeUndefined();
  });

  it("should return undefined when denials have no questions", () => {
    const result = formatAskUserDenials([
      { tool_input: { questions: [] } },
      { tool_input: undefined },
      {},
    ]);

    expect(result).toBeUndefined();
  });

  it("should skip denials without tool_input and include ones with questions", () => {
    const result = formatAskUserDenials([
      {},
      {
        tool_input: {
          questions: [{ question: "Valid question" }],
        },
      },
    ]);

    expect(result).toContain("Valid question");
  });
});
