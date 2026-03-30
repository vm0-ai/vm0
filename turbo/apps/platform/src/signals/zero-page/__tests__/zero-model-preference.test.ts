import { command } from "ccstate";
import { describe, expect, it } from "vitest";
import { mockLocation } from "../../location.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { initRoutes$ } from "../../route.ts";
import { setRootSignal$ } from "../../root-signal.ts";
import {
  createPushStateMock,
  updateTestPathname$,
} from "../../../__tests__/page-helper.ts";
import {
  selectedModel$,
  setSelectedModel$,
  syncModelPreference$,
  persistModelPreference$,
} from "../zero-model-preference.ts";

const context = testContext();

const noop$ = command(() => void 0);

async function setupTalkRoutes(pathname: string) {
  context.store.set(setRootSignal$, context.signal);
  createPushStateMock(context.signal);
  mockLocation({ pathname, search: "" }, context.signal);
  await context.store.set(
    initRoutes$,
    [
      { path: "/", setup: noop$ },
      { path: "/talk/:agentId", setup: noop$ },
      { path: "{/*path}", setup: noop$ },
    ],
    context.signal,
  );
}

describe("zero-model-preference signals", () => {
  it("should default selectedModel to 'default'", () => {
    expect(context.store.get(selectedModel$)).toBe("default");
  });

  it("should update selectedModel via setSelectedModel$", () => {
    context.store.set(setSelectedModel$, "openai");
    expect(context.store.get(selectedModel$)).toBe("openai");
  });

  it("should sync model preference from localStorage for current agent", async () => {
    await setupTalkRoutes("/talk/my-agent");
    localStorage.setItem("zero.modelProvider.my-agent", "anthropic");

    context.store.set(syncModelPreference$);

    expect(context.store.get(selectedModel$)).toBe("anthropic");
  });

  it("should sync to 'default' when no localStorage entry exists", async () => {
    await setupTalkRoutes("/talk/new-agent");
    // Set to something first
    context.store.set(setSelectedModel$, "openai");

    context.store.set(syncModelPreference$);

    expect(context.store.get(selectedModel$)).toBe("default");
  });

  it("should use 'default' key when zeroTalkAgentId is null", () => {
    mockLocation({ pathname: "/", search: "" }, context.signal);
    localStorage.setItem("zero.modelProvider.default", "anthropic");

    context.store.set(syncModelPreference$);

    expect(context.store.get(selectedModel$)).toBe("anthropic");
  });

  it("should persist model preference to localStorage", async () => {
    await setupTalkRoutes("/talk/my-agent");
    context.store.set(setSelectedModel$, "openai");

    context.store.set(persistModelPreference$);

    expect(localStorage.getItem("zero.modelProvider.my-agent")).toBe("openai");
  });

  it("should remove localStorage entry when persisting 'default'", async () => {
    await setupTalkRoutes("/talk/my-agent");
    localStorage.setItem("zero.modelProvider.my-agent", "openai");
    context.store.set(setSelectedModel$, "default");

    context.store.set(persistModelPreference$);

    expect(localStorage.getItem("zero.modelProvider.my-agent")).toBeNull();
  });

  it("should reset model selection when agent changes via sync", async () => {
    // Agent-a has a saved preference; agent-b does not.
    // Each sync should read localStorage for the current agent.
    localStorage.setItem("zero.modelProvider.agent-a", "anthropic");

    // Start on agent-a
    await setupTalkRoutes("/talk/agent-a");
    context.store.set(syncModelPreference$);
    expect(context.store.get(selectedModel$)).toBe("anthropic");

    context.store.set(updateTestPathname$, "/talk/agent-b");

    context.store.set(syncModelPreference$);
    expect(context.store.get(selectedModel$)).toBe("default");
  });
});
