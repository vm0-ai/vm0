import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  freshPreparations$,
  fetchFreshPreparations$,
} from "../voice-chat-preparation.ts";

const context = testContext();

function setup() {
  detachedSetupPage({
    context,
    path: "/voice-chat",
    withoutRender: true,
  });
}

function mockListEndpoint(
  preparations: {
    id: string;
    mode: string;
    prompt: string | null;
    agentId: string | null;
    createdAt: string;
  }[],
) {
  const calls: unknown[] = [];
  server.use(
    http.get("*/api/zero/voice-chat/prepare/list", () => {
      calls.push({});
      return HttpResponse.json({ preparations });
    }),
  );
  return calls;
}

describe("fetchFreshPreparations$", () => {
  it("should populate freshPreparations$ with API response", async () => {
    setup();
    const items = [
      {
        id: "prep-1",
        mode: "meeting",
        prompt: "discuss quarterly goals",
        agentId: "agent-1",
        createdAt: "2026-04-14T10:00:00Z",
      },
      {
        id: "prep-2",
        mode: "meeting",
        prompt: "sprint review",
        agentId: "agent-1",
        createdAt: "2026-04-14T09:30:00Z",
      },
    ];
    mockListEndpoint(items);

    await context.store.set(fetchFreshPreparations$, context.signal);

    const result = context.store.get(freshPreparations$);
    expect(result).toHaveLength(2);
    expect(result[0]).toStrictEqual({
      id: "prep-1",
      mode: "meeting",
      prompt: "discuss quarterly goals",
      agentId: "agent-1",
      createdAt: "2026-04-14T10:00:00Z",
    });
    expect(result[1]).toStrictEqual({
      id: "prep-2",
      mode: "meeting",
      prompt: "sprint review",
      agentId: "agent-1",
      createdAt: "2026-04-14T09:30:00Z",
    });
  });

  it("should return empty list when no preparations exist", async () => {
    setup();
    mockListEndpoint([]);

    await context.store.set(fetchFreshPreparations$, context.signal);

    expect(context.store.get(freshPreparations$)).toHaveLength(0);
  });

  it("should throw on API error", async () => {
    setup();
    server.use(
      http.get("*/api/zero/voice-chat/prepare/list", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await expect(
      context.store.set(fetchFreshPreparations$, context.signal),
    ).rejects.toThrow();
  });
});
