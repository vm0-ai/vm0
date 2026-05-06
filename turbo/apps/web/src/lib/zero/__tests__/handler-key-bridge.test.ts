import { describe, it, expect } from "vitest";
import { PROVIDER_HANDLERS } from "../connector/provider-registry";
import {
  HANDLER_KEY_SOURCE_TYPE,
  MODEL_PROVIDER_HANDLER_KEY,
  SOURCE_HANDLER_TO_PROVIDER_TYPE,
  getRefreshSourceType,
} from "../handler-key-bridge";

describe("handler-key bridge tables stay in sync", () => {
  it("every value in MODEL_PROVIDER_HANDLER_KEY appears as a model-provider key in HANDLER_KEY_SOURCE_TYPE", () => {
    for (const handlerKey of Object.values(MODEL_PROVIDER_HANDLER_KEY)) {
      expect(handlerKey).toBeDefined();
      expect(HANDLER_KEY_SOURCE_TYPE[handlerKey!]).toBe("model-provider");
    }
  });

  it("every key in HANDLER_KEY_SOURCE_TYPE appears as a value in MODEL_PROVIDER_HANDLER_KEY", () => {
    for (const handlerKey of Object.keys(HANDLER_KEY_SOURCE_TYPE)) {
      expect(Object.values(MODEL_PROVIDER_HANDLER_KEY)).toContain(handlerKey);
    }
  });

  it("SOURCE_HANDLER_TO_PROVIDER_TYPE inverts MODEL_PROVIDER_HANDLER_KEY", () => {
    for (const [providerType, handlerKey] of Object.entries(
      MODEL_PROVIDER_HANDLER_KEY,
    )) {
      expect(handlerKey).toBeDefined();
      expect(SOURCE_HANDLER_TO_PROVIDER_TYPE[handlerKey!]).toBe(providerType);
    }
  });

  it("every handler key in HANDLER_KEY_SOURCE_TYPE has a matching SOURCE_HANDLER_TO_PROVIDER_TYPE entry", () => {
    for (const handlerKey of Object.keys(HANDLER_KEY_SOURCE_TYPE)) {
      expect(SOURCE_HANDLER_TO_PROVIDER_TYPE[handlerKey]).toBeDefined();
    }
  });

  it("every bridged handler key resolves to a registered ProviderHandler with refreshToken", () => {
    for (const handlerKey of Object.values(MODEL_PROVIDER_HANDLER_KEY)) {
      const handler =
        PROVIDER_HANDLERS[handlerKey as keyof typeof PROVIDER_HANDLERS];
      expect(handler).toBeDefined();
      expect(handler.refreshToken).toBeDefined();
    }
  });
});

describe("getRefreshSourceType", () => {
  it("returns 'model-provider' for bridged handler keys", () => {
    expect(getRefreshSourceType("chatgpt-oauth")).toBe("model-provider");
  });

  it("returns 'connector' for unbridged handler keys (default)", () => {
    expect(getRefreshSourceType("github")).toBe("connector");
    expect(getRefreshSourceType("notion")).toBe("connector");
    expect(getRefreshSourceType("totally-unknown")).toBe("connector");
  });
});
