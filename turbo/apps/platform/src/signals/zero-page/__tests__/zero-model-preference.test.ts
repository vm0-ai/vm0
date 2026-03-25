import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { mockLocation, setPathname } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { updatePathname$ } from "../../route.ts";
import {
  selectedModel$,
  setSelectedModel$,
  syncModelPreference$,
  persistModelPreference$,
} from "../zero-model-preference.ts";

const context = testContext();

describe("zero-model-preference signals", () => {
  it("should default selectedModel to 'default'", () => {
    expect(context.store.get(selectedModel$)).toBe("default");
  });

  it("should update selectedModel via setSelectedModel$", () => {
    context.store.set(setSelectedModel$, "openai");
    expect(context.store.get(selectedModel$)).toBe("openai");
  });

  it("should sync model preference from server for current agent", async () => {
    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: { "my-agent": "anthropic" },
        });
      }),
    );

    mockLocation({ pathname: "/talk/my-agent", search: "" }, context.signal);

    await context.store.set(syncModelPreference$, context.signal);

    expect(context.store.get(selectedModel$)).toBe("anthropic");
  });

  it("should sync to 'default' when server has no preference for agent", async () => {
    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: {},
        });
      }),
    );

    mockLocation({ pathname: "/talk/new-agent", search: "" }, context.signal);
    context.store.set(setSelectedModel$, "openai");

    await context.store.set(syncModelPreference$, context.signal);

    expect(context.store.get(selectedModel$)).toBe("default");
  });

  it("should use 'default' key when zeroTalkAgentId is null", async () => {
    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: { default: "anthropic" },
        });
      }),
    );

    mockLocation({ pathname: "/", search: "" }, context.signal);

    await context.store.set(syncModelPreference$, context.signal);

    expect(context.store.get(selectedModel$)).toBe("anthropic");
  });

  it("should persist model preference to server via API", async () => {
    let capturedBody: unknown = null;

    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: {},
        });
      }),
      http.post("*/api/zero/user-preferences", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: { "my-agent": "openai" },
        });
      }),
    );

    mockLocation({ pathname: "/talk/my-agent", search: "" }, context.signal);
    context.store.set(setSelectedModel$, "openai");

    await context.store.set(persistModelPreference$, context.signal);

    expect(capturedBody).toStrictEqual({
      modelPreferences: { "my-agent": "openai" },
    });
  });

  it("should remove agent key from server when persisting 'default'", async () => {
    let capturedBody: unknown = null;

    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: { "my-agent": "openai" },
        });
      }),
      http.post("*/api/zero/user-preferences", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: {},
        });
      }),
    );

    mockLocation({ pathname: "/talk/my-agent", search: "" }, context.signal);
    context.store.set(setSelectedModel$, "default");

    await context.store.set(persistModelPreference$, context.signal);

    expect(capturedBody).toStrictEqual({
      modelPreferences: {},
    });
  });

  it("should reset model selection when agent changes via sync", async () => {
    server.use(
      http.get("*/api/zero/user-preferences", () => {
        return HttpResponse.json({
          timezone: null,
          pinnedAgentIds: [],
          sendMode: "enter",
          modelPreferences: { "agent-a": "anthropic" },
        });
      }),
    );

    // Start on agent-a
    mockLocation({ pathname: "/talk/agent-a", search: "" }, context.signal);
    await context.store.set(syncModelPreference$, context.signal);
    expect(context.store.get(selectedModel$)).toBe("anthropic");

    // Navigate to agent-b
    setPathname("/talk/agent-b");
    context.store.set(updatePathname$, "/talk/agent-b");

    await context.store.set(syncModelPreference$, context.signal);
    expect(context.store.get(selectedModel$)).toBe("default");
  });
});
