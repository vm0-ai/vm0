import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../axiom", () => ({
  queryAxiom: vi.fn(),
  getDatasetName: (base: string) => `test-${base}`,
  DATASETS: { AGENT_RUN_EVENTS: "agent-run-events" },
}));

import { queryAxiom } from "../../axiom";
import {
  extractRunOutput,
  extractAllRunOutputs,
  getAllRunOutputTexts,
  formatAskUserDenials,
  buildDeepLinksFromFlags,
  type RunOutput,
} from "../extract-run-output";

const mockQueryAxiom = vi.mocked(queryAxiom);

beforeEach(() => {
  mockQueryAxiom.mockReset();
});

// ---------------------------------------------------------------------------
// extractRunOutput (single — last event)
// ---------------------------------------------------------------------------

describe("extractRunOutput", () => {
  it("returns empty output when no events found", async () => {
    mockQueryAxiom.mockResolvedValue([]);

    const output = await extractRunOutput("run-1");

    expect(output).toEqual({
      result: null,
      askUserDenials: [],
      modelProviderIssue: false,
      connectorIssue: false,
      error: null,
    });
  });

  it("returns the last event when multiple exist", async () => {
    mockQueryAxiom.mockResolvedValue([
      { eventData: { result: "first" } },
      { eventData: { result: "second" } },
      { eventData: { result: "last" } },
    ]);

    const output = await extractRunOutput("run-1");

    expect(output.result).toBe("last");
  });

  it("passes error through", async () => {
    mockQueryAxiom.mockResolvedValue([]);

    const output = await extractRunOutput("run-1", "sandbox crashed");

    expect(output.error).toBe("sandbox crashed");
    expect(output.result).toBeNull();
  });

  it("detects model provider issues in result text", async () => {
    mockQueryAxiom.mockResolvedValue([
      { eventData: { result: "model provider not configured" } },
    ]);

    const output = await extractRunOutput("run-1");

    expect(output.modelProviderIssue).toBe(true);
    expect(output.connectorIssue).toBe(false);
  });

  it("detects connector issues in result text", async () => {
    mockQueryAxiom.mockResolvedValue([
      { eventData: { result: "missing variable for connector" } },
    ]);

    const output = await extractRunOutput("run-1");

    expect(output.connectorIssue).toBe(true);
  });

  it("filters AskUserQuestion denials from permission_denials", async () => {
    mockQueryAxiom.mockResolvedValue([
      {
        eventData: {
          result: "done",
          permission_denials: [
            {
              tool_name: "AskUserQuestion",
              tool_input: { questions: [{ question: "Pick one" }] },
            },
            { tool_name: "Bash" },
          ],
        },
      },
    ]);

    const output = await extractRunOutput("run-1");

    expect(output.askUserDenials).toHaveLength(1);
    expect(output.askUserDenials[0]!.tool_name).toBe("AskUserQuestion");
  });
});

// ---------------------------------------------------------------------------
// extractAllRunOutputs (multi)
// ---------------------------------------------------------------------------

describe("extractAllRunOutputs", () => {
  it("returns one empty output when no events found", async () => {
    mockQueryAxiom.mockResolvedValue([]);

    const outputs = await extractAllRunOutputs("run-1");

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.result).toBeNull();
    expect(outputs[0]!.error).toBeNull();
  });

  it("returns one empty output with error when no events found", async () => {
    mockQueryAxiom.mockResolvedValue([]);

    const outputs = await extractAllRunOutputs("run-1", "timeout");

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.error).toBe("timeout");
  });

  it("returns one output per event in order", async () => {
    mockQueryAxiom.mockResolvedValue([
      { eventData: { result: "step 1 done" } },
      { eventData: { result: "step 2 done" } },
      { eventData: { result: "final summary" } },
    ]);

    const outputs = await extractAllRunOutputs("run-1");

    expect(outputs).toHaveLength(3);
    expect(outputs.map((o) => o.result)).toEqual([
      "step 1 done",
      "step 2 done",
      "final summary",
    ]);
  });

  it("handles events with missing result gracefully", async () => {
    mockQueryAxiom.mockResolvedValue([
      { eventData: {} },
      { eventData: { result: "has result" } },
    ]);

    const outputs = await extractAllRunOutputs("run-1");

    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.result).toBeNull();
    expect(outputs[1]!.result).toBe("has result");
  });
});

// ---------------------------------------------------------------------------
// getAllRunOutputTexts
// ---------------------------------------------------------------------------

describe("getAllRunOutputTexts", () => {
  it("returns empty array when all events have no result", async () => {
    mockQueryAxiom.mockResolvedValue([{ eventData: {} }]);

    const texts = await getAllRunOutputTexts("run-1");

    expect(texts).toEqual([]);
  });

  it("returns text for each event with a result", async () => {
    mockQueryAxiom.mockResolvedValue([
      { eventData: { result: "first result" } },
      { eventData: { result: "second result" } },
    ]);

    const texts = await getAllRunOutputTexts("run-1");

    expect(texts).toEqual(["first result", "second result"]);
  });

  it("skips events without result but includes those with denials only", async () => {
    mockQueryAxiom.mockResolvedValue([
      { eventData: { result: "ok" } },
      {
        eventData: {
          permission_denials: [
            {
              tool_name: "AskUserQuestion",
              tool_input: { questions: [{ question: "Choose color" }] },
            },
          ],
        },
      },
    ]);

    const texts = await getAllRunOutputTexts("run-1");

    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe("ok");
    expect(texts[1]).toContain("Choose color");
  });

  it("appends formatted denials to result text", async () => {
    mockQueryAxiom.mockResolvedValue([
      {
        eventData: {
          result: "Need input",
          permission_denials: [
            {
              tool_name: "AskUserQuestion",
              tool_input: { questions: [{ question: "Yes or no?" }] },
            },
          ],
        },
      },
    ]);

    const texts = await getAllRunOutputTexts("run-1");

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Need input");
    expect(texts[0]).toContain("Yes or no?");
  });
});

// ---------------------------------------------------------------------------
// formatAskUserDenials
// ---------------------------------------------------------------------------

describe("formatAskUserDenials", () => {
  it("returns undefined for empty denials", () => {
    expect(formatAskUserDenials([])).toBeUndefined();
  });

  it("returns undefined when denials have no questions", () => {
    expect(
      formatAskUserDenials([{ tool_name: "AskUserQuestion" }]),
    ).toBeUndefined();
  });

  it("formats question with options", () => {
    const result = formatAskUserDenials([
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Pick a color",
              options: [
                { label: "Red", description: "Warm" },
                { label: "Blue" },
              ],
            },
          ],
        },
      },
    ]);

    expect(result).toContain("Pick a color");
    expect(result).toContain("Red — Warm");
    expect(result).toContain("Blue");
  });
});

// ---------------------------------------------------------------------------
// buildDeepLinksFromFlags
// ---------------------------------------------------------------------------

describe("buildDeepLinksFromFlags", () => {
  const baseOutput: RunOutput = {
    result: null,
    askUserDenials: [],
    modelProviderIssue: false,
    connectorIssue: false,
    error: null,
  };

  it("returns empty array when no issues", () => {
    expect(buildDeepLinksFromFlags(baseOutput, "https://app.vm0.ai")).toEqual(
      [],
    );
  });

  it("returns provider link when modelProviderIssue is true", () => {
    const links = buildDeepLinksFromFlags(
      { ...baseOutput, modelProviderIssue: true },
      "https://app.vm0.ai",
    );

    expect(links).toHaveLength(1);
    expect(links[0]!.url).toBe("https://app.vm0.ai/settings");
  });

  it("returns connector link with agent name", () => {
    const links = buildDeepLinksFromFlags(
      { ...baseOutput, connectorIssue: true },
      "https://app.vm0.ai",
      "my-agent",
    );

    expect(links).toHaveLength(1);
    expect(links[0]!.url).toContain("/team/my-agent?tab=connectors");
  });

  it("returns both links when both issues present", () => {
    const links = buildDeepLinksFromFlags(
      { ...baseOutput, modelProviderIssue: true, connectorIssue: true },
      "https://app.vm0.ai",
    );

    expect(links).toHaveLength(2);
  });
});
