import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock os.homedir to use temp directory for config isolation
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-config-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

import { getToken, getActiveToken, getActiveOrg } from "../config";

describe("token resolution", () => {
  beforeEach(async () => {
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  async function writeConfigToken(token: string): Promise<void> {
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ token }),
    );
  }

  describe("getActiveToken", () => {
    it("should return ZERO_TOKEN when set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-token-value");

      const token = await getActiveToken();
      expect(token).toBe("zero-token-value");
    });

    it("should fall back to VM0_TOKEN when ZERO_TOKEN is not set", async () => {
      vi.stubEnv("VM0_TOKEN", "vm0-token-value");

      const token = await getActiveToken();
      expect(token).toBe("vm0-token-value");
    });

    it("should fall back to config file when neither env var is set", async () => {
      await writeConfigToken("config-token-value");

      const token = await getActiveToken();
      expect(token).toBe("config-token-value");
    });

    it("should return ZERO_TOKEN over VM0_TOKEN when both are set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-wins");
      vi.stubEnv("VM0_TOKEN", "vm0-loses");

      const token = await getActiveToken();
      expect(token).toBe("zero-wins");
    });

    it("should return undefined when no token source is available", async () => {
      const token = await getActiveToken();
      expect(token).toBeUndefined();
    });
  });

  describe("getActiveOrg", () => {
    function buildFakeJwt(payload: Record<string, unknown>): string {
      const header = Buffer.from(
        JSON.stringify({ alg: "HS256", typ: "JWT" }),
      ).toString("base64url");
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const sig = Buffer.from("fake-signature").toString("base64url");
      return `vm0_sandbox_${header}.${body}.${sig}`;
    }

    async function writeConfigOrg(activeOrg: string): Promise<void> {
      const configDir = path.join(TEST_HOME, ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ activeOrg }),
      );
    }

    it("should return orgId from ZERO_TOKEN when set", async () => {
      vi.stubEnv(
        "ZERO_TOKEN",
        buildFakeJwt({ scope: "zero", orgId: "org-from-jwt" }),
      );

      const org = await getActiveOrg();
      expect(org).toBe("org-from-jwt");
    });

    it("should prefer ZERO_TOKEN over VM0_ACTIVE_ORG", async () => {
      vi.stubEnv(
        "ZERO_TOKEN",
        buildFakeJwt({ scope: "zero", orgId: "jwt-org" }),
      );
      vi.stubEnv("VM0_ACTIVE_ORG", "env-org");

      const org = await getActiveOrg();
      expect(org).toBe("jwt-org");
    });

    it("should fall back to VM0_ACTIVE_ORG when ZERO_TOKEN is absent", async () => {
      vi.stubEnv("VM0_ACTIVE_ORG", "env-org");

      const org = await getActiveOrg();
      expect(org).toBe("env-org");
    });

    it("should fall back to config file when both env vars are absent", async () => {
      vi.stubEnv("VM0_ACTIVE_ORG", "");
      await writeConfigOrg("config-org");

      const org = await getActiveOrg();
      expect(org).toBe("config-org");
    });

    it("should return undefined when nothing is set", async () => {
      vi.stubEnv("VM0_ACTIVE_ORG", "");

      const org = await getActiveOrg();
      expect(org).toBeUndefined();
    });

    it("should ignore sandbox-scoped token", async () => {
      vi.stubEnv(
        "ZERO_TOKEN",
        buildFakeJwt({ scope: "sandbox", runId: "run-1" }),
      );
      vi.stubEnv("VM0_ACTIVE_ORG", "fallback-org");

      const org = await getActiveOrg();
      expect(org).toBe("fallback-org");
    });

    it("should ignore compose-job-scoped token", async () => {
      vi.stubEnv(
        "ZERO_TOKEN",
        buildFakeJwt({ scope: "compose-job", jobId: "job-1" }),
      );
      vi.stubEnv("VM0_ACTIVE_ORG", "fallback-org");

      const org = await getActiveOrg();
      expect(org).toBe("fallback-org");
    });

    it("should ignore malformed ZERO_TOKEN", async () => {
      vi.stubEnv("ZERO_TOKEN", "not-a-valid-token");
      vi.stubEnv("VM0_ACTIVE_ORG", "fallback-org");

      const org = await getActiveOrg();
      expect(org).toBe("fallback-org");
    });

    it("should ignore ZERO_TOKEN with invalid base64 payload", async () => {
      vi.stubEnv("ZERO_TOKEN", "vm0_sandbox_header.!!!invalid!!!.signature");
      vi.stubEnv("VM0_ACTIVE_ORG", "fallback-org");

      const org = await getActiveOrg();
      expect(org).toBe("fallback-org");
    });
  });

  describe("getToken", () => {
    it("should return ZERO_TOKEN when set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-token-value");

      const token = await getToken();
      expect(token).toBe("zero-token-value");
    });

    it("should fall back to VM0_TOKEN when ZERO_TOKEN is not set", async () => {
      vi.stubEnv("VM0_TOKEN", "vm0-token-value");

      const token = await getToken();
      expect(token).toBe("vm0-token-value");
    });

    it("should fall back to config file when neither env var is set", async () => {
      await writeConfigToken("config-token-value");

      const token = await getToken();
      expect(token).toBe("config-token-value");
    });

    it("should return ZERO_TOKEN over VM0_TOKEN when both are set", async () => {
      vi.stubEnv("ZERO_TOKEN", "zero-wins");
      vi.stubEnv("VM0_TOKEN", "vm0-loses");

      const token = await getToken();
      expect(token).toBe("zero-wins");
    });
  });
});
