import { describe, expect, it } from "vitest";
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

  it("should sync model preference from localStorage for current agent", () => {
    mockLocation({ pathname: "/talk/my-agent", search: "" }, context.signal);
    localStorage.setItem("zero.modelProvider.my-agent", "anthropic");

    context.store.set(syncModelPreference$);

    expect(context.store.get(selectedModel$)).toBe("anthropic");
  });

  it("should sync to 'default' when no localStorage entry exists", () => {
    mockLocation({ pathname: "/talk/new-agent", search: "" }, context.signal);
    // Set to something first
    context.store.set(setSelectedModel$, "openai");

    context.store.set(syncModelPreference$);

    expect(context.store.get(selectedModel$)).toBe("default");
  });

  it("should use 'default' key when zeroChatAgentName is null", () => {
    mockLocation({ pathname: "/", search: "" }, context.signal);
    localStorage.setItem("zero.modelProvider.default", "anthropic");

    context.store.set(syncModelPreference$);

    expect(context.store.get(selectedModel$)).toBe("anthropic");
  });

  it("should persist model preference to localStorage", () => {
    mockLocation({ pathname: "/talk/my-agent", search: "" }, context.signal);
    context.store.set(setSelectedModel$, "openai");

    context.store.set(persistModelPreference$);

    expect(localStorage.getItem("zero.modelProvider.my-agent")).toBe("openai");
  });

  it("should remove localStorage entry when persisting 'default'", () => {
    mockLocation({ pathname: "/talk/my-agent", search: "" }, context.signal);
    localStorage.setItem("zero.modelProvider.my-agent", "openai");
    context.store.set(setSelectedModel$, "default");

    context.store.set(persistModelPreference$);

    expect(localStorage.getItem("zero.modelProvider.my-agent")).toBeNull();
  });

  it("should reset model selection when agent changes via sync", () => {
    // Agent-a has a saved preference; agent-b does not.
    // Each sync should read localStorage for the current agent.
    localStorage.setItem("zero.modelProvider.agent-a", "anthropic");

    // Start on agent-a
    mockLocation({ pathname: "/talk/agent-a", search: "" }, context.signal);
    context.store.set(syncModelPreference$);
    expect(context.store.get(selectedModel$)).toBe("anthropic");

    // Navigate to agent-b — use setPathname + updatePathname$ to
    // both update the override and trigger pathname$ recomputation.
    setPathname("/talk/agent-b");
    context.store.set(updatePathname$, "/talk/agent-b");

    context.store.set(syncModelPreference$);
    expect(context.store.get(selectedModel$)).toBe("default");
  });
});
