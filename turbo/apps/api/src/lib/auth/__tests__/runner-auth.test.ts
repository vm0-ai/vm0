import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRunnerAuth,
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  type RunnerAuthContext,
} from "../runner-auth";

const TEST_OFFICIAL_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_CLI_TOKEN = "vm0_live_test_token_12345";
const TEST_USER_ID = "user_test_123";

// Mock the headers
const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

// Mock init-services and globalThis.services
vi.mock("../../init-services", () => ({
  initServices: vi.fn(),
}));

// Mock the logger
vi.mock("../../logger", () => ({
  logger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock the sandbox-token module
vi.mock("../sandbox-token", () => ({
  isSandboxToken: (token: string) => token.split(".").length === 3,
}));

// Setup globalThis.services mock
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  catch: vi.fn(),
};

const mockEnv = {
  OFFICIAL_RUNNER_SECRET: TEST_OFFICIAL_SECRET,
};

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).services = {
    db: mockDb,
    env: mockEnv,
  };
});

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).services;
});

describe("runner-auth", () => {
  describe("OFFICIAL_RUNNER_TOKEN_PREFIX", () => {
    it("should be vm0_official_", () => {
      expect(OFFICIAL_RUNNER_TOKEN_PREFIX).toBe("vm0_official_");
    });
  });

  describe("getRunnerAuth", () => {
    describe("with no Authorization header", () => {
      it("should return null", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(null),
        });

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });
    });

    describe("with non-Bearer token", () => {
      it("should return null", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue("Basic sometoken"),
        });

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });
    });

    describe("with sandbox JWT token", () => {
      it("should return null (sandbox tokens are rejected)", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue("Bearer header.payload.signature"),
        });

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });
    });

    describe("with official runner token", () => {
      it("should return official-runner context when secret matches", async () => {
        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${TEST_OFFICIAL_SECRET}`;
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(`Bearer ${token}`),
        });

        const result = await getRunnerAuth();
        expect(result).toEqual({ type: "official-runner" });
      });

      it("should return null when secret does not match", async () => {
        const wrongSecret = "wrong_secret_that_does_not_match_at_all_here";
        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${wrongSecret}`;
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(`Bearer ${token}`),
        });

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });

      it("should return null when OFFICIAL_RUNNER_SECRET is not configured", async () => {
        // @ts-expect-error - mocking undefined secret
        globalThis.services.env.OFFICIAL_RUNNER_SECRET = undefined;

        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${TEST_OFFICIAL_SECRET}`;
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(`Bearer ${token}`),
        });

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });

      it("should be timing-safe and reject secrets with different lengths", async () => {
        const shortSecret = "short";
        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${shortSecret}`;
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(`Bearer ${token}`),
        });

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });
    });

    describe("with CLI token", () => {
      it("should return user context when token is valid", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(`Bearer ${TEST_CLI_TOKEN}`),
        });

        // Mock database to return valid token record
        mockDb.limit.mockResolvedValue([
          {
            token: TEST_CLI_TOKEN,
            userId: TEST_USER_ID,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour from now
          },
        ]);

        const result = await getRunnerAuth();
        expect(result).toEqual({ type: "user", userId: TEST_USER_ID });
      });

      it("should return null when token is not found", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(`Bearer ${TEST_CLI_TOKEN}`),
        });

        // Mock database to return empty result
        mockDb.limit.mockResolvedValue([]);

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });

      it("should update lastUsedAt timestamp", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue(`Bearer ${TEST_CLI_TOKEN}`),
        });

        // Track how many times where is called to handle both select and update chains
        let whereCallCount = 0;
        const mockCatch = vi.fn().mockResolvedValue(undefined);

        mockDb.where.mockImplementation(() => {
          whereCallCount++;
          if (whereCallCount === 1) {
            // First where call is for select chain
            return {
              limit: vi.fn().mockResolvedValue([
                {
                  token: TEST_CLI_TOKEN,
                  userId: TEST_USER_ID,
                  expiresAt: new Date(Date.now() + 1000 * 60 * 60),
                },
              ]),
            };
          }
          // Second where call is for update chain
          return { catch: mockCatch };
        });

        await getRunnerAuth();

        // Verify update was called
        expect(mockDb.update).toHaveBeenCalled();
      });
    });

    describe("with unknown token format", () => {
      it("should return null for random string", async () => {
        mockHeaders.mockResolvedValue({
          get: vi.fn().mockReturnValue("Bearer random_unknown_token"),
        });

        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });
    });
  });

  describe("RunnerAuthContext type", () => {
    it("should type check user context correctly", () => {
      const userAuth: RunnerAuthContext = { type: "user", userId: "test-123" };
      expect(userAuth.type).toBe("user");
      if (userAuth.type === "user") {
        expect(userAuth.userId).toBe("test-123");
      }
    });

    it("should type check official-runner context correctly", () => {
      const runnerAuth: RunnerAuthContext = { type: "official-runner" };
      expect(runnerAuth.type).toBe("official-runner");
    });
  });
});
