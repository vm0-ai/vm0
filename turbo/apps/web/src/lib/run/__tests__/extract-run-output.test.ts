import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @axiomhq/js at the package boundary (not internal modules).
// We provide a controllable `query` method that returns Axiom-shaped responses.
const mockQuery = vi.fn();
vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(function () {
    return { query: mockQuery };
  }),
}));

import { reloadEnv } from "../../../env";
import {
  extractRunOutput,
  extractAllRunOutputs,
  getAllRunOutputTexts,
  formatAskUserDenials,
} from "../extract-run-output";

/**
 * Helper to build an Axiom query response in the shape returned by the SDK.
 * Each item becomes a match entry with `_time` and `data`.
 */
function axiomResponse(events: Array<Record<string, unknown>>): {
  matches: Array<{ _time: string; data: Record<string, unknown> }>;
} {
  return {
    matches: events.map((data) => ({
      _time: new Date().toISOString(),
      data,
    })),
  };
}

beforeEach(() => {
  vi.stubEnv("AXIOM_TOKEN_SESSIONS", "test-axiom-token");
  // Reload env() cache after stubbing the token so the axiom client sees it
  reloadEnv();
  mockQuery.mockReset();
});

// ---------------------------------------------------------------------------
// extractRunOutput (single — last event)
// ---------------------------------------------------------------------------

describe("extractRunOutput", () => {
  it("returns empty output when no events found", async () => {
    mockQuery.mockResolvedValue(axiomResponse([]));

    const output = await extractRunOutput("run-1");

    expect(output).toEqual({
      result: null,
      askUserDenials: [],
      error: null,
    });
  });

  it("returns the result from the single event returned by the limit-1 query", async () => {
    // queryResultEvent uses `limit 1 + order by desc` so Axiom returns only the latest event
    mockQuery.mockResolvedValue(
      axiomResponse([{ eventData: { result: "latest" } }]),
    );

    const output = await extractRunOutput("run-1");

    expect(output.result).toBe("latest");
  });

  it("passes error through", async () => {
    mockQuery.mockResolvedValue(axiomResponse([]));

    const output = await extractRunOutput("run-1", "sandbox crashed");

    expect(output.error).toBe("sandbox crashed");
    expect(output.result).toBeNull();
  });

  it("filters AskUserQuestion denials from permission_denials", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
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
      ]),
    );

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
    mockQuery.mockResolvedValue(axiomResponse([]));

    const outputs = await extractAllRunOutputs("run-1");

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.result).toBeNull();
    expect(outputs[0]!.error).toBeNull();
  });

  it("returns one empty output with error when no events found", async () => {
    mockQuery.mockResolvedValue(axiomResponse([]));

    const outputs = await extractAllRunOutputs("run-1", "timeout");

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.error).toBe("timeout");
  });

  it("returns one output per event in order", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
        { eventData: { result: "step 1 done" } },
        { eventData: { result: "step 2 done" } },
        { eventData: { result: "final summary" } },
      ]),
    );

    const outputs = await extractAllRunOutputs("run-1");

    expect(outputs).toHaveLength(3);
    expect(outputs.map((o) => o.result)).toEqual([
      "step 1 done",
      "step 2 done",
      "final summary",
    ]);
  });

  it("handles events with missing result gracefully", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
        { eventData: {} },
        { eventData: { result: "has result" } },
      ]),
    );

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
    mockQuery.mockResolvedValue(axiomResponse([{ eventData: {} }]));

    const texts = await getAllRunOutputTexts("run-1");

    expect(texts).toEqual([]);
  });

  it("returns text for each event with a result", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
        { eventData: { result: "first result" } },
        { eventData: { result: "second result" } },
      ]),
    );

    const texts = await getAllRunOutputTexts("run-1");

    expect(texts).toEqual(["first result", "second result"]);
  });

  it("skips events without result but includes those with denials only", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
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
      ]),
    );

    const texts = await getAllRunOutputTexts("run-1");

    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe("ok");
    expect(texts[1]).toContain("Choose color");
  });

  it("appends formatted denials to result text", async () => {
    mockQuery.mockResolvedValue(
      axiomResponse([
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
      ]),
    );

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
