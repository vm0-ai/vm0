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

const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

function buildZeroToken(orgId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      runId: "run-1",
      orgId,
      scope: "zero",
      capabilities: [],
      iat: 1000,
      exp: 2000,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

describe("withErrorHandler", () => {
  let mockExit: MockInstance;
  let mockConsoleError: MockInstance;

  beforeEach(() => {
    mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("should show ZERO_TOKEN setup guidance when it is missing", async () => {
    const handler = withErrorHandler(async () => {
      throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
    });

    await handler();

    const output = mockConsoleError.mock.calls
      .map((c) => {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("Not authenticated");
    expect(output).toContain("Set ZERO_TOKEN to a valid run token");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show ZERO_TOKEN guidance for UNAUTHORIZED with ZERO_TOKEN set", async () => {
    vi.stubEnv("ZERO_TOKEN", "some-token");

    const handler = withErrorHandler(async () => {
      throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
    });

    await handler();

    const output = mockConsoleError.mock.calls
      .map((c) => {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("Authentication failed");
    expect(output).toContain("ZERO_TOKEN is invalid or expired");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show status and message for non-UNAUTHORIZED ApiRequestError", async () => {
    const handler = withErrorHandler(async () => {
      throw new ApiRequestError("Something went wrong", "UNKNOWN", 500);
    });

    await handler();

    const output = mockConsoleError.mock.calls
      .map((c) => {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("500");
    expect(output).toContain("Something went wrong");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should hide default-disabled plan upgrade guidance for PRO_REQUIRED", async () => {
    const handler = withErrorHandler(async () => {
      throw new ApiRequestError(
        "Built-in video generation requires a paid plan",
        "PRO_REQUIRED",
        402,
      );
    });

    await handler();

    const output = mockConsoleError.mock.calls
      .map((c) => {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("Paid plan required");
    expect(output).not.toContain("Return the plan upgrade link");
    expect(output).not.toContain("zero upgrade pro");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show enabled plan upgrade guidance for PRO_REQUIRED", async () => {
    vi.stubEnv("ZERO_TOKEN", buildZeroToken(STAFF_ORG_ID));
    const handler = withErrorHandler(async () => {
      throw new ApiRequestError(
        "Built-in video generation requires a paid plan",
        "PRO_REQUIRED",
        402,
      );
    });

    await handler();

    const output = mockConsoleError.mock.calls
      .map((c) => {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("Return the plan upgrade link");
    expect(output).toContain("zero upgrade pro");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show error message for plain Error", async () => {
    const handler = withErrorHandler(async () => {
      throw new Error("Plain error message");
    });

    await handler();

    const output = mockConsoleError.mock.calls
      .map((c) => {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("Plain error message");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("should show cause message when error has a cause", async () => {
    const handler = withErrorHandler(async () => {
      throw new Error("Main error", { cause: new Error("Root cause") });
    });

    await handler();

    const output = mockConsoleError.mock.calls
      .map((c) => {
        return c[0];
      })
      .join("\n");
    expect(output).toContain("Main error");
    expect(output).toContain("Root cause");
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
