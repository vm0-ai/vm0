import {
  describe,
  it,
  expect,
  vi,
  type MockInstance,
  beforeEach,
  afterEach,
} from "vitest";
import { withErrorHandler } from "../with-error-handler";
import { ApiRequestError } from "../../api/core/client-factory";

describe("withErrorHandler", () => {
  let mockExit: MockInstance;
  let mockConsoleError: MockInstance;

  beforeEach(() => {
    mockExit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("should show vm0 auth guidance for UNAUTHORIZED without ZERO_TOKEN", async () => {
    const handler = withErrorHandler(async () => {
      throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
    });

    await handler();

    const output = mockConsoleError.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Not authenticated");
    expect(output).toContain("vm0 auth login");
    expect(output).not.toContain("ZERO_TOKEN");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show ZERO_TOKEN guidance for UNAUTHORIZED with ZERO_TOKEN set", async () => {
    vi.stubEnv("ZERO_TOKEN", "some-token");

    const handler = withErrorHandler(async () => {
      throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
    });

    await handler();

    const output = mockConsoleError.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Authentication failed");
    expect(output).toContain("ZERO_TOKEN is invalid or expired");
    expect(output).not.toContain("vm0 auth login");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show status and message for non-UNAUTHORIZED ApiRequestError", async () => {
    const handler = withErrorHandler(async () => {
      throw new ApiRequestError("Something went wrong", "UNKNOWN", 500);
    });

    await handler();

    const output = mockConsoleError.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("500");
    expect(output).toContain("Something went wrong");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show error message for plain Error", async () => {
    const handler = withErrorHandler(async () => {
      throw new Error("Plain error message");
    });

    await handler();

    const output = mockConsoleError.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Plain error message");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show cause message when error has a cause", async () => {
    const handler = withErrorHandler(async () => {
      throw new Error("Main error", { cause: new Error("Root cause") });
    });

    await handler();

    const output = mockConsoleError.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Main error");
    expect(output).toContain("Root cause");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
