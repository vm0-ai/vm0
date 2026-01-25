import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { eq } from "drizzle-orm";
import { initServices } from "../../init-services";
import { cliTokens } from "../../../db/schema/cli-tokens";
import type { RunnerAuthContext } from "../runner-auth";

const TEST_OFFICIAL_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_CLI_TOKEN = "vm0_live_test_token_12345";
const TEST_USER_ID = "test-user-runner-auth";

// Set required environment variables before initServices
vi.hoisted(() => {
  vi.stubEnv(
    "OFFICIAL_RUNNER_SECRET",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  );
});

// Mock the sandbox-token module (external dependency)
vi.mock("../sandbox-token", () => ({
  isSandboxToken: (token: string) => token.split(".").length === 3,
}));

// Import module after setting up mocks
let getRunnerAuth: typeof import("../runner-auth").getRunnerAuth;
let OFFICIAL_RUNNER_TOKEN_PREFIX: typeof import("../runner-auth").OFFICIAL_RUNNER_TOKEN_PREFIX;

describe("runner-auth", () => {
  beforeAll(async () => {
    initServices();
    // Dynamically import to ensure initServices runs first
    const authModule = await import("../runner-auth");
    getRunnerAuth = authModule.getRunnerAuth;
    OFFICIAL_RUNNER_TOKEN_PREFIX = authModule.OFFICIAL_RUNNER_TOKEN_PREFIX;
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // Clean up test data
    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.userId, TEST_USER_ID));
  });

  afterAll(async () => {
    // Final cleanup
    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.userId, TEST_USER_ID));
  });

  describe("OFFICIAL_RUNNER_TOKEN_PREFIX", () => {
    it("should be vm0_official_", () => {
      expect(OFFICIAL_RUNNER_TOKEN_PREFIX).toBe("vm0_official_");
    });
  });

  describe("getRunnerAuth", () => {
    describe("with no Authorization header", () => {
      it("should return null", async () => {
        const result = await getRunnerAuth();
        expect(result).toBeNull();
      });

      it("should return null with undefined", async () => {
        const result = await getRunnerAuth(undefined);
        expect(result).toBeNull();
      });
    });

    describe("with non-Bearer token", () => {
      it("should return null", async () => {
        const result = await getRunnerAuth("Basic sometoken");
        expect(result).toBeNull();
      });
    });

    describe("with sandbox JWT token", () => {
      it("should return null (sandbox tokens are rejected)", async () => {
        const result = await getRunnerAuth("Bearer header.payload.signature");
        expect(result).toBeNull();
      });
    });

    describe("with official runner token", () => {
      it("should return official-runner context when secret matches", async () => {
        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${TEST_OFFICIAL_SECRET}`;
        const result = await getRunnerAuth(`Bearer ${token}`);
        expect(result).toEqual({ type: "official-runner" });
      });

      it("should return null when secret does not match", async () => {
        const wrongSecret = "wrong_secret_that_does_not_match_at_all_here";
        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${wrongSecret}`;
        const result = await getRunnerAuth(`Bearer ${token}`);
        expect(result).toBeNull();
      });

      it("should return null when OFFICIAL_RUNNER_SECRET is not configured", async () => {
        // Temporarily unset the cached environment variable
        const originalSecret = globalThis.services.env.OFFICIAL_RUNNER_SECRET;
        // Use type assertion to bypass readonly constraint for testing
        (
          globalThis.services.env as {
            OFFICIAL_RUNNER_SECRET: string | undefined;
          }
        ).OFFICIAL_RUNNER_SECRET = undefined;

        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${TEST_OFFICIAL_SECRET}`;
        const result = await getRunnerAuth(`Bearer ${token}`);
        expect(result).toBeNull();

        // Restore the environment variable
        (
          globalThis.services.env as {
            OFFICIAL_RUNNER_SECRET: string | undefined;
          }
        ).OFFICIAL_RUNNER_SECRET = originalSecret;
      });

      it("should be timing-safe and reject secrets with different lengths", async () => {
        const shortSecret = "short";
        const token = `${OFFICIAL_RUNNER_TOKEN_PREFIX}${shortSecret}`;
        const result = await getRunnerAuth(`Bearer ${token}`);
        expect(result).toBeNull();
      });
    });

    describe("with CLI token", () => {
      it("should return user context when token is valid", async () => {
        // Insert real test token into database
        await globalThis.services.db.insert(cliTokens).values({
          token: TEST_CLI_TOKEN,
          userId: TEST_USER_ID,
          name: "Test Token",
          expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour from now
        });

        const result = await getRunnerAuth(`Bearer ${TEST_CLI_TOKEN}`);
        expect(result).toEqual({ type: "user", userId: TEST_USER_ID });
      });

      it("should return null when token is not found", async () => {
        const result = await getRunnerAuth(`Bearer ${TEST_CLI_TOKEN}`);
        expect(result).toBeNull();
      });

      it("should update lastUsedAt timestamp", async () => {
        // Insert real test token into database without lastUsedAt
        await globalThis.services.db.insert(cliTokens).values({
          token: TEST_CLI_TOKEN,
          userId: TEST_USER_ID,
          name: "Test Token",
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
          lastUsedAt: null,
        });

        const result = await getRunnerAuth(`Bearer ${TEST_CLI_TOKEN}`);

        // Verify the result
        expect(result).toEqual({ type: "user", userId: TEST_USER_ID });

        // Wait a bit for the non-blocking update to complete
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Verify lastUsedAt was updated in the database
        const [tokenRecord] = await globalThis.services.db
          .select()
          .from(cliTokens)
          .where(eq(cliTokens.token, TEST_CLI_TOKEN));

        expect(tokenRecord).toBeDefined();
        expect(tokenRecord!.lastUsedAt).not.toBeNull();
        expect(tokenRecord!.lastUsedAt).toBeInstanceOf(Date);
      });
    });

    describe("with unknown token format", () => {
      it("should return null for random string", async () => {
        const result = await getRunnerAuth("Bearer random_unknown_token");
        expect(result).toBeNull();
      });
    });
  });

  describe("RunnerAuthContext type", () => {
    it("should type check user context correctly", () => {
      const userAuth: RunnerAuthContext = {
        type: "user",
        userId: "test-123",
      };
      expect(userAuth.type).toBe("user");
      if (userAuth.type === "user") {
        expect(userAuth.userId).toBe("test-123");
      }
    });

    it("should type check official-runner context correctly", () => {
      const runnerAuth: RunnerAuthContext = {
        type: "official-runner",
      };
      expect(runnerAuth.type).toBe("official-runner");
    });
  });
});
