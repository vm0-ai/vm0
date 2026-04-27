import { logger } from "../log";

describe("logger", () => {
  it("caches logger instances by name", () => {
    expect(logger("Cache")).toBe(logger("Cache"));
  });
});
