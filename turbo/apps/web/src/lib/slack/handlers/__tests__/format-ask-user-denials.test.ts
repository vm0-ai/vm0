import { describe, it, expect } from "vitest";
import { parseAskUserFromResponse, formatAskUserQuestions } from "../run-agent";

describe("parseAskUserFromResponse", () => {
  it("should parse a valid ask_user block", () => {
    const text = `Some response text.

\`\`\`ask_user
{"questions":[{"question":"Which framework?","header":"Framework","options":[{"label":"React","description":"UI library"},{"label":"Vue"}],"multiSelect":false}]}
\`\`\``;

    const result = parseAskUserFromResponse(text);

    expect(result).not.toBeNull();
    expect(result!.questions).toHaveLength(1);
    expect(result!.questions[0]!.question).toBe("Which framework?");
    expect(result!.questions[0]!.header).toBe("Framework");
    expect(result!.questions[0]!.options).toHaveLength(2);
    expect(result!.cleanText).toBe("Some response text.");
  });

  it("should return null when no ask_user block is present", () => {
    const result = parseAskUserFromResponse("Just some plain text.");
    expect(result).toBeNull();
  });

  it("should return null for invalid JSON in ask_user block", () => {
    const text = `Text.

\`\`\`ask_user
{invalid json}
\`\`\``;

    const result = parseAskUserFromResponse(text);
    expect(result).toBeNull();
  });

  it("should return null when JSON does not match schema", () => {
    const text = `Text.

\`\`\`ask_user
{"questions":[{"invalid":"field"}]}
\`\`\``;

    const result = parseAskUserFromResponse(text);
    expect(result).toBeNull();
  });

  it("should strip the ask_user block from cleanText", () => {
    const text = `Here is my analysis.\n\nI need some input.\n\n\`\`\`ask_user\n{"questions":[{"question":"Pick one?"}]}\n\`\`\``;

    const result = parseAskUserFromResponse(text);

    expect(result).not.toBeNull();
    expect(result!.cleanText).toBe(
      "Here is my analysis.\n\nI need some input.",
    );
  });

  it("should handle ask_user block with no preceding text", () => {
    const text = `\`\`\`ask_user\n{"questions":[{"question":"Pick one?"}]}\n\`\`\``;

    const result = parseAskUserFromResponse(text);

    expect(result).not.toBeNull();
    expect(result!.cleanText).toBe("");
    expect(result!.questions).toHaveLength(1);
  });

  it("should parse multiple questions", () => {
    const text = `Response.\n\n\`\`\`ask_user\n{"questions":[{"question":"Q1?"},{"question":"Q2?","multiSelect":true}]}\n\`\`\``;

    const result = parseAskUserFromResponse(text);

    expect(result).not.toBeNull();
    expect(result!.questions).toHaveLength(2);
    expect(result!.questions[1]!.multiSelect).toBe(true);
  });

  it("should handle questions with optional fields omitted", () => {
    const text = `Text.\n\n\`\`\`ask_user\n{"questions":[{"question":"Simple question?"}]}\n\`\`\``;

    const result = parseAskUserFromResponse(text);

    expect(result).not.toBeNull();
    expect(result!.questions[0]!.header).toBeUndefined();
    expect(result!.questions[0]!.options).toBeUndefined();
    expect(result!.questions[0]!.multiSelect).toBeUndefined();
  });
});

describe("formatAskUserQuestions", () => {
  it("should format a single question without options", () => {
    const result = formatAskUserQuestions([
      { question: "Which database should I use?" },
    ]);

    expect(result).toBe(
      "The agent needs your input to proceed:\n\nWhich database should I use?",
    );
  });

  it("should format a question with options", () => {
    const result = formatAskUserQuestions([
      {
        question: "Which framework do you prefer?",
        options: [
          { label: "React", description: "A UI library" },
          { label: "Vue", description: "A progressive framework" },
        ],
      },
    ]);

    expect(result).toContain("Which framework do you prefer?");
    expect(result).toContain("  \u2022 React \u2014 A UI library");
    expect(result).toContain("  \u2022 Vue \u2014 A progressive framework");
  });

  it("should format options without descriptions", () => {
    const result = formatAskUserQuestions([
      {
        question: "Pick one:",
        options: [{ label: "Option A" }, { label: "Option B" }],
      },
    ]);

    expect(result).toContain("  \u2022 Option A");
    expect(result).toContain("  \u2022 Option B");
    expect(result).not.toContain("\u2014");
  });

  it("should format multiple questions", () => {
    const result = formatAskUserQuestions([
      { question: "First question?" },
      { question: "Second question?" },
    ]);

    expect(result).toContain("First question?");
    expect(result).toContain("Second question?");
  });

  it("should return fallback for empty questions array", () => {
    const result = formatAskUserQuestions([]);
    expect(result).toBe("The agent needs your input to proceed.");
  });
});
