import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { dispatchProgressCallbacks } from "../dispatcher";
import { testContext, type UserContext } from "../../../__tests__/test-helpers";
import { mockClerk } from "../../../__tests__/clerk-mock";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
  completeTestRun,
  failTestRun,
} from "../../../__tests__/api-test-helpers";

const context = testContext();

describe("dispatchProgressCallbacks", () => {
  let user: UserContext;
  let testRunId: string;

  beforeEach(async () => {
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
    const capturedRequests: { url: string; body: Record<string, unknown> }[] =
      [];

    server.use(
      http.post(
        "http://localhost/api/internal/callbacks/slack",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          capturedRequests.push({ url: request.url, body });
          return HttpResponse.json({ success: true });
        },
      ),
    );

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123", channelId: "C123", threadTs: "123.456" },
    });

    await dispatchProgressCallbacks(testRunId);

    expect(capturedRequests).toHaveLength(1);
    const captured = capturedRequests[0]!;
    expect(captured.url).toBe("http://localhost/api/internal/callbacks/slack");
    expect(captured.body.status).toBe("progress");
    expect(captured.body.runId).toBe(testRunId);
    expect(captured.body.payload).toEqual({
      workspaceId: "T123",
      channelId: "C123",
      threadTs: "123.456",
    });
  });

  it("should not update callback status (subsequent calls still work)", async () => {
    let callCount = 0;

    server.use(
      http.post("http://localhost/api/internal/callbacks/slack", () => {
        callCount++;
        return HttpResponse.json({ success: true });
      }),
    );

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123" },
    });

    // First progress call
    await dispatchProgressCallbacks(testRunId);
    expect(callCount).toBe(1);

    // Second progress call should also work (callback still pending)
    await dispatchProgressCallbacks(testRunId);
    expect(callCount).toBe(2);
  });

  it("should do nothing when no callbacks exist", async () => {
    let callCount = 0;

    server.use(
      http.post("http://localhost/api/internal/callbacks/slack", () => {
        callCount++;
        return HttpResponse.json({ success: true });
      }),
    );

    await dispatchProgressCallbacks(testRunId);

    expect(callCount).toBe(0);
  });

  it("should silently ignore fetch failures", async () => {
    server.use(
      http.post("http://localhost/api/internal/callbacks/slack", () => {
        return HttpResponse.error();
      }),
    );

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123" },
    });

    // Should not throw
    await dispatchProgressCallbacks(testRunId);
  });

  it("should skip when run is already completed", async () => {
    let callCount = 0;

    server.use(
      http.post("http://localhost/api/internal/callbacks/slack", () => {
        callCount++;
        return HttpResponse.json({ success: true });
      }),
    );

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123" },
    });

    await completeTestRun(user.userId, testRunId);

    await dispatchProgressCallbacks(testRunId);

    expect(callCount).toBe(0);
  });

  it("should skip when run is already failed", async () => {
    let callCount = 0;

    server.use(
      http.post("http://localhost/api/internal/callbacks/slack", () => {
        callCount++;
        return HttpResponse.json({ success: true });
      }),
    );

    await createTestCallback({
      runId: testRunId,
      url: "http://localhost/api/internal/callbacks/slack",
      payload: { workspaceId: "T123" },
    });

    await failTestRun(user.userId, testRunId);

    await dispatchProgressCallbacks(testRunId);

    expect(callCount).toBe(0);
  });
});
