import { describe, expect, it } from "vitest";
import { chatThreadEventSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "../chat-thread-event-replay";

const created = chatThreadEventSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  seqId: 1,
  kind: "created",
  chatThreadId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000003",
  title: null,
  selectedModel: "claude-sonnet-5",
  selectedVideoModel: null,
  createdAt: "2026-09-09T00:00:00.000Z",
});
const selected = {
  ...created,
  id: "00000000-0000-4000-8000-000000000004",
  seqId: 2,
  kind: "model_selection_updated" as const,
  reasoningEffort: "high" as const,
  createdAt: "2026-09-09T00:00:01.000Z",
};

describe("reasoning effort event replay", () => {
  it("replays a selection received before its creation event", () => {
    expect(replayChatThreadEvents([], [selected, created])[0]).toMatchObject({
      reasoningEffort: "high",
    });
  });

  it("preserves snapshots across legacy events and applies explicit resets", () => {
    const snapshot = replayChatThreadEvents([], [created, selected]);
    const legacyUpdate = {
      ...created,
      kind: "model_selection_updated" as const,
      seqId: 3,
      createdAt: "2026-09-09T00:00:02.000Z",
    };
    expect(replayChatThreadEvents(snapshot, [legacyUpdate])[0]).toMatchObject({
      reasoningEffort: "high",
    });
    expect(
      replayChatThreadEvents(snapshot, [
        { ...legacyUpdate, reasoningEffort: null },
      ])[0],
    ).toMatchObject({ reasoningEffort: null });
    expect(replayChatThreadEvents([], [created])[0]).not.toHaveProperty(
      "reasoningEffort",
    );
  });
});
