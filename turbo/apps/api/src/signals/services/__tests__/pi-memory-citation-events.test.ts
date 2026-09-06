import { describe, expect, it } from "vitest";

import type { EventConsumerPayload } from "../../../lib/event-consumer/verify";
import { normalizeRunOutputEvents } from "../pi-memory-citation-events";

const citation = {
  entries: [{ path: "memory.md", lineStart: 1, lineEnd: 2, note: "used" }],
  rolloutIds: ["019c6e27-e55b-73d1-87d8-4e01f1f75043"],
} as const;
const envelope = `<oai-mem-citation><citation_entries>memory.md:1-2|note=[used]</citation_entries><rollout_ids>${citation.rolloutIds[0]}</rollout_ids></oai-mem-citation>`;

function payload(events: EventConsumerPayload["events"]): EventConsumerPayload {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    events,
    context: { userId: "user", orgId: "org" },
  };
}

describe("Pi run output normalization", () => {
  it("defensively normalizes an old Guest without duplicating terminal provenance", () => {
    const normalized = normalizeRunOutputEvents(
      payload([
        {
          type: "assistant",
          sequenceNumber: 4,
          message: {
            content: [{ type: "text", text: `visible${envelope}` }],
          },
        },
        { type: "result", sequenceNumber: 5, result: `visible${envelope}` },
      ]),
      true,
    );
    expect(normalized.payload.events).toStrictEqual([
      {
        type: "assistant",
        sequenceNumber: 4,
        message: { content: [{ type: "text", text: "visible" }] },
      },
      { type: "result", sequenceNumber: 5, result: "visible" },
    ]);
    expect(normalized.citations).toStrictEqual([
      { sequenceNumber: 4, citation },
    ]);
  });

  it("accepts a new Guest structured field and removes it from log consumers", () => {
    const normalized = normalizeRunOutputEvents(
      payload([
        {
          type: "assistant",
          sequenceNumber: 7,
          message: {
            content: [{ type: "text", text: "visible" }],
            memoryCitation: citation,
          },
        },
      ]),
      true,
    );
    expect(normalized.payload.events[0]).not.toHaveProperty(
      "message.memoryCitation",
    );
    expect(normalized.citations).toStrictEqual([
      { sequenceNumber: 7, citation },
    ]);
  });

  it("parses one hidden envelope across separately delivered assistant chunks", () => {
    const split = 15;
    const normalized = normalizeRunOutputEvents(
      payload([
        {
          type: "assistant",
          sequenceNumber: 1,
          message: {
            content: [
              { type: "text", text: `before${envelope.slice(0, split)}` },
            ],
          },
        },
        {
          type: "assistant",
          sequenceNumber: 2,
          message: {
            content: [{ type: "text", text: `${envelope.slice(split)}after` }],
          },
        },
      ]),
      true,
    );
    expect(normalized.payload.events).toMatchObject([
      { message: { content: [{ text: "before" }] } },
      { message: { content: [{ text: "after" }] } },
    ]);
    expect(normalized.citations).toStrictEqual([
      { sequenceNumber: 2, citation },
    ]);
  });

  it("leaves non-Pi text byte-for-byte unchanged", () => {
    const original = payload([
      {
        type: "assistant",
        sequenceNumber: 1,
        message: { content: [{ type: "text", text: `literal ${envelope}` }] },
      },
    ]);
    const normalized = normalizeRunOutputEvents(original, false);
    expect(normalized.payload.events[0]).toBe(original.events[0]);
    expect(normalized.citations).toStrictEqual([]);
  });

  it("drops malformed structured metadata before optional log consumers", () => {
    const normalized = normalizeRunOutputEvents(
      payload([
        {
          type: "assistant",
          sequenceNumber: 1,
          message: {
            content: [{ type: "text", text: "visible" }],
            memoryCitation: { entries: "private-path" },
          },
        },
        {
          type: "result",
          sequenceNumber: 2,
          result: "visible",
          memoryCitation: { rolloutIds: ["not-a-uuid"] },
        },
      ]),
      true,
    );
    expect(normalized.payload.events).toStrictEqual([
      {
        type: "assistant",
        sequenceNumber: 1,
        message: { content: [{ type: "text", text: "visible" }] },
      },
      { type: "result", sequenceNumber: 2, result: "visible" },
    ]);
    expect(normalized.citations).toStrictEqual([]);
  });

  it("does not join a partial opener across separate assistant messages", () => {
    const normalized = normalizeRunOutputEvents(
      payload([
        {
          type: "assistant",
          sequenceNumber: 1,
          message: {
            id: "first",
            content: [{ type: "text", text: "visible<oai-mem-cit" }],
          },
        },
        {
          type: "user",
          sequenceNumber: 2,
          message: { content: [] },
        },
        {
          type: "assistant",
          sequenceNumber: 3,
          message: {
            id: "second",
            content: [{ type: "text", text: "ation>ordinary" }],
          },
        },
      ]),
      true,
    );
    expect(normalized.payload.events).toMatchObject([
      { message: { content: [{ text: "visible<oai-mem-cit" }] } },
      { type: "user" },
      { message: { content: [{ text: "ation>ordinary" }] } },
    ]);
    expect(normalized.citations).toStrictEqual([]);
  });

  it("preserves identical provenance on distinct assistant messages", () => {
    const normalized = normalizeRunOutputEvents(
      payload([
        {
          type: "assistant",
          sequenceNumber: 1,
          message: {
            id: "first",
            content: [{ type: "text", text: "first" }],
            memoryCitation: citation,
          },
        },
        { type: "user", sequenceNumber: 2, message: { content: [] } },
        {
          type: "assistant",
          sequenceNumber: 3,
          message: {
            id: "second",
            content: [{ type: "text", text: "second" }],
            memoryCitation: citation,
          },
        },
        { type: "result", sequenceNumber: 4, result: `second${envelope}` },
      ]),
      true,
    );
    expect(normalized.citations).toStrictEqual([
      { sequenceNumber: 1, citation },
      { sequenceNumber: 3, citation },
    ]);
  });
});
