import { describe, it, expect, vi, beforeEach } from "vitest";
import chalk from "chalk";
import { ApiRequestError } from "../../api/core/client-factory";
import { withErrorHandler } from "../with-error-handler";

describe("withErrorHandler", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    chalk.level = 0;
  });

  it("should call the action and not exit on success", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const wrapped = withErrorHandler(action);

    await wrapped("arg1", "arg2");

    expect(action).toHaveBeenCalledWith("arg1", "arg2");
    expect(mockConsoleError).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("should show fixed auth format for UNAUTHORIZED ApiRequestError", async () => {
    const action = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401),
      );
    const wrapped = withErrorHandler(action);

    await expect(wrapped()).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Not authenticated"),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Run: vm0 auth login"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show status and message for non-auth ApiRequestError", async () => {
    const action = vi
      .fn()
      .mockRejectedValue(
        new ApiRequestError("Connector not found", "NOT_FOUND", 404),
      );
    const wrapped = withErrorHandler(action);

    await expect(wrapped()).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("404: Connector not found"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show message for plain Error", async () => {
    const action = vi.fn().mockRejectedValue(new Error("Something went wrong"));
    const wrapped = withErrorHandler(action);

    await expect(wrapped()).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Something went wrong"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show cause when error has a cause", async () => {
    const cause = new Error("ECONNREFUSED");
    const action = vi
      .fn()
      .mockRejectedValue(new Error("Login failed", { cause }));
    const wrapped = withErrorHandler(action);

    await expect(wrapped()).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Login failed"),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Cause: ECONNREFUSED"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show cause for ApiRequestError with cause", async () => {
    const cause = new Error("network timeout");
    const error = new ApiRequestError(
      "Internal server error",
      "INTERNAL_SERVER_ERROR",
      500,
    );
    error.cause = cause;
    const action = vi.fn().mockRejectedValue(error);
    const wrapped = withErrorHandler(action);

    await expect(wrapped()).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("500: Internal server error"),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("Cause: network timeout"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show generic message for non-Error throws", async () => {
    const action = vi.fn().mockRejectedValue("string error");
    const wrapped = withErrorHandler(action);

    await expect(wrapped()).rejects.toThrow("process.exit called");

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("An unexpected error occurred"),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should forward all arguments to the wrapped function", async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const wrapped = withErrorHandler(action);

    await wrapped("first", { option: true }, { verbose: false });

    expect(action).toHaveBeenCalledWith(
      "first",
      { option: true },
      { verbose: false },
    );
  });
});
