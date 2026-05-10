import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { type FeatureSwitchContext } from "@vm0/core/feature-switch";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  insertOrgDefaultModelProvider,
  getTestChatMessagesByThread,
} from "../../../../../../src/__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";

/**
 * Override `isFeatureEnabled` for the `Goal` switch only — every other key
 * delegates to the real registry. A blanket `mockReturnValue(true)` would
 * flip on `ModelFirstModelProvider` and route the request through a
 * credit-checked vm0-managed provider path, breaking the 201 assertions
 * with a 402 in tests that seed `anthropic-api-key` instead.
 */
let goalSwitchEnabled = true;
vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn(
      (key: FeatureSwitchKey, ctx: FeatureSwitchContext) => {
        if (key === FeatureSwitchKey.Goal) {
          return goalSwitchEnabled;
        }
        return actual.isFeatureEnabled(key, ctx);
      },
    ),
  };
});

const context = testContext();

const URL = "http://localhost:3000/api/zero/chat/messages";

describe("POST /api/zero/chat/messages — goal mode", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    goalSwitchEnabled = true;
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("chat-msg-goal"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
    await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
  });

  it("persists goal columns when sending with goal=true", async () => {
    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt: "Migrate the auth middleware off the legacy session store",
          goal: true,
        }),
      }),
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.runId).toBeTruthy();

    await context.mocks.flushAfter();

    const rows = await getTestChatMessagesByThread(data.threadId);
    const userRow = rows.find((r) => {
      return r.role === "user";
    });
    if (!userRow) {
      throw new Error("Expected goal user row to be persisted");
    }
    expect(userRow.goalRemainingTurns).toBe(10);
    // Origin self-references the row id so future continuations can walk
    // the chain back to the original objective.
    expect(userRow.goalOriginMessageId).toBe(userRow.id);
    expect(userRow.content).toBe(
      "Migrate the auth middleware off the legacy session store",
    );
  });

  it("queues a goal message with goal columns when an active run exists", async () => {
    const first = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt: "first message",
        }),
      }),
    );
    expect(first.status).toBe(201);
    const firstData = await first.json();
    await context.mocks.flushAfter();

    const second = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt: "Refactor every export from src/lib/utils into named exports",
          threadId: firstData.threadId,
          goal: true,
        }),
      }),
    );
    expect(second.status).toBe(201);
    const secondData = await second.json();
    expect(secondData.runId).toBeNull();

    const rows = await getTestChatMessagesByThread(firstData.threadId);
    const queuedGoal = rows.find((r) => {
      return r.role === "user" && r.goalRemainingTurns !== null;
    });
    if (!queuedGoal) {
      throw new Error("Expected queued goal row to be persisted");
    }
    expect(queuedGoal.runId).toBeNull();
    expect(queuedGoal.goalRemainingTurns).toBe(10);
    expect(queuedGoal.goalOriginMessageId).toBe(queuedGoal.id);
  });

  it("returns 403 when the goal feature switch is disabled", async () => {
    goalSwitchEnabled = false;

    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt: "Run a long-horizon refactor",
          goal: true,
        }),
      }),
    );

    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("does not set goal columns when goal flag is omitted", async () => {
    const response = await POST(
      createTestRequest(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          prompt: "regular non-goal message",
        }),
      }),
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    await context.mocks.flushAfter();

    const rows = await getTestChatMessagesByThread(data.threadId);
    const userRow = rows.find((r) => {
      return r.role === "user";
    });
    if (!userRow) {
      throw new Error("Expected user row to be persisted");
    }
    expect(userRow.goalRemainingTurns).toBeNull();
    expect(userRow.goalOriginMessageId).toBeNull();
  });
});
