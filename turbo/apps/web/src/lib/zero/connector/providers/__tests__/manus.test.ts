import { describe, expect, it } from "vitest";
import { manusHandler } from "../manus-handler";

describe("manusHandler", () => {
  it("throws on buildAuthUrl", () => {
    expect(() => manusHandler.buildAuthUrl({} as never)).toThrow(
      "Manus does not support OAuth — use API key auth",
    );
  });

  it("throws on exchangeCode", () => {
    expect(() => manusHandler.exchangeCode({} as never)).toThrow(
      "Manus does not support OAuth — use API key auth",
    );
  });

  it("returns undefined for getClientId", () => {
    expect(manusHandler.getClientId()).toBeUndefined();
  });

  it("returns undefined for getClientSecret", () => {
    expect(manusHandler.getClientSecret()).toBeUndefined();
  });

  it("returns MANUS_TOKEN for getSecretName", () => {
    expect(manusHandler.getSecretName()).toBe("MANUS_TOKEN");
  });
});
