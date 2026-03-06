import { describe, it, expect, beforeEach, vi } from "vitest";
import { dispatchProgressCallbacks } from "../dispatcher";
import { testContext, type UserContext } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
} from "../../../__tests__/api-test-helpers";

const context = testContext();

describe("dispatchProgressCallbacks", () => {
  let user: UserContext;
  let testRunId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    context.setupMocks();
    user = await context.setupUser();
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(
      `agent-progress-${Date.now()}`,
    );
    const { runId } = await createTestRun(composeId, "Test prompt");
    testRunId = runId;
  });

  it("should send progress notification to pending callbacks", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123", channelId: "C123", threadTs: "123.456" },
    });

    await dispatchProgressCallbacks(testRunId);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://localhost/api/internal/callbacks/slack");
    const body = JSON.parse(options!.body as string);
    expect(body.status).toBe("progress");
    expect(body.runId).toBe(testRunId);
    expect(body.payload).toEqual({
      workspaceId: "T123",
      channelId: "C123",
      threadTs: "123.456",
    });

    fetchSpy.mockRestore();
  });

  it("should not update callback status (subsequent calls still work)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123" },
    });

    // First progress call
    await dispatchProgressCallbacks(testRunId);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second progress call should also work (callback still pending)
    await dispatchProgressCallbacks(testRunId);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockRestore();
  });

  it("should do nothing when no callbacks exist", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

    await dispatchProgressCallbacks(testRunId);

    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("should silently ignore fetch failures", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123" },
    });

    // Should not throw
    await dispatchProgressCallbacks(testRunId);

    vi.restoreAllMocks();
  });
});
