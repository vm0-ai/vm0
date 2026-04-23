import { describe, it, expect } from "vitest";
import { lovartHandler } from "../lovart-handler";

describe("lovartHandler", () => {
  it("should throw on buildAuthUrl (no OAuth)", () => {
    expect(() => lovartHandler.buildAuthUrl("id", "redirect", "state")).toThrow(
      "Lovart does not support OAuth",
    );
  });

  it("should throw on exchangeCode (no OAuth)", () => {
    expect(() =>
      lovartHandler.exchangeCode("id", "secret", "code", "redirect"),
    ).toThrow("Lovart does not support OAuth");
  });

  it("should return undefined for getClientId", () => {
    expect(lovartHandler.getClientId({} as never)).toBeUndefined();
  });

  it("should return undefined for getClientSecret", () => {
    expect(lovartHandler.getClientSecret({} as never)).toBeUndefined();
  });

  it("should return LOVART_ACCESS_KEY for getSecretName", () => {
    expect(lovartHandler.getSecretName()).toBe("LOVART_ACCESS_KEY");
  });
});
