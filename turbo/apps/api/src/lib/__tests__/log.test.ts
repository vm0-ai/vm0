import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockEnv } from "../env";
import { logger } from "../log";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("caches logger instances by name", () => {
    expect(logger("Cache")).toBe(logger("Cache"));
  });

  it("suppresses debug logs by default", () => {
    logger("DefaultDebug").debug("hidden");

    expect(logSpy).not.toHaveBeenCalled();
  });

  it("enables debug logs for exact VM0_DEBUG matches", () => {
    mockEnv("VM0_DEBUG", "ExactDebug");

    logger("ExactDebug").debug("visible");

    expect(logSpy).toHaveBeenCalledWith("[DEBUG][ExactDebug] visible");
  });

  it("enables debug logs for wildcard VM0_DEBUG matches", () => {
    mockEnv("VM0_DEBUG", "api:*");

    logger("api:route").debug("visible");

    expect(logSpy).toHaveBeenCalledWith("[DEBUG][api:route] visible");
  });

  it("writes warn logs through stdout for Vercel runtime logs", () => {
    logger("Warn").warn("slow request");

    expect(logSpy).toHaveBeenCalledWith("[WARN][Warn] slow request");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("writes error logs through stderr", () => {
    const error = new Error("boom");

    logger("Error").error("failed", error);

    expect(errorSpy).toHaveBeenCalledWith("[ERROR][Error] failed", error);
  });
});
