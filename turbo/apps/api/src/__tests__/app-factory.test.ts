import * as Sentry from "@sentry/node";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testContext } from "./test-helpers";

const sentry = vi.hoisted(() => {
  return {
    captureException: vi.fn(),
    init: vi.fn(),
  };
});

vi.mock("@sentry/node", () => {
  return sentry;
});

describe("createApp", () => {
  const context = testContext();
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(Sentry.captureException).mockClear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("captures unhandled errors and returns a sanitized response", async () => {
    const app = context.app;
    const error = new Error("boom");

    app.get("/boom", () => {
      throw error;
    });

    const response = await app.request("/boom");
    const payload: unknown = await response.json();

    expect(response.status).toBe(500);
    expect(payload).toEqual({ error: "Internal server error" });
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ERROR][App] Unhandled request error",
      error,
    );
  });

  it("passes through expected HTTP client errors without capturing them", async () => {
    const app = context.app;
    const error = new HTTPException(404, { message: "Missing" });

    app.get("/missing", () => {
      throw error;
    });

    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("captures HTTP server errors while preserving their response", async () => {
    const app = context.app;
    const error = new HTTPException(503, { message: "Unavailable" });

    app.get("/unavailable", () => {
      throw error;
    });

    const response = await app.request("/unavailable");

    expect(response.status).toBe(503);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
