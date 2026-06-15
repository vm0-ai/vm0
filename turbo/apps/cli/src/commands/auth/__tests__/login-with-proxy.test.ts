/**
 * Integration tests for auth login with HTTP proxy configuration.
 *
 * Verifies that when proxy env vars are set, the CLI configures the global proxy
 * before making auth requests. When proxy is unreachable, login fails with a
 * clear error. When no proxy is set, login completes successfully.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import { server } from "../../../mocks/server";

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-auth-proxy-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
  };
});

describe("auth login: proxy configuration", () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const emitWarningOriginal = process.emitWarning.bind(process);
  const emitWarning = vi
    .spyOn(process, "emitWarning")
    .mockImplementation((warning, options) => {
      if (
        typeof options === "object" &&
        options !== null &&
        "code" in options &&
        options.code === "UNDICI-EHPA"
      ) {
        return;
      }
      return emitWarningOriginal(warning as string, options as never);
    });
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => {
    return true;
  });

  beforeEach(async () => {
    vi.resetModules();
    emitWarning.mockClear();
    chalk.level = 0;

    vi.stubEnv("http_proxy", undefined);
    vi.stubEnv("HTTP_PROXY", undefined);
    vi.stubEnv("https_proxy", undefined);
    vi.stubEnv("HTTPS_PROXY", undefined);
    vi.stubEnv("no_proxy", undefined);
    vi.stubEnv("NO_PROXY", undefined);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");

    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function setupSuccessfulAuth() {
    server.use(
      http.post("http://localhost:3000/api/cli/auth/device", () => {
        return HttpResponse.json({
          device_code: "test-device-code",
          user_code: "TEST-CODE",
          verification_path: "/auth/device",
          expires_in: 300,
          interval: 5,
        });
      }),
      http.post("http://localhost:3000/api/cli/auth/token", () => {
        return HttpResponse.json({
          access_token: "test-access-token",
          token_type: "bearer",
        });
      }),
    );
  }

  it("completes login when no proxy env vars are set", async () => {
    setupSuccessfulAuth();

    const { configureGlobalProxyFromEnv } =
      await import("../../../lib/network/proxy");
    const { loginCommand } = await import("../login");

    configureGlobalProxyFromEnv();
    await loginCommand.parseAsync(["node", "cli"]);

    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Authentication successful"),
    );
  });

  it("reports error when http_proxy is set to unreachable address", async () => {
    vi.stubEnv("http_proxy", "http://127.0.0.1:59999");

    const { configureGlobalProxyFromEnv } =
      await import("../../../lib/network/proxy");
    const { loginCommand } = await import("../login");

    configureGlobalProxyFromEnv();

    await expect(loginCommand.parseAsync(["node", "cli"])).rejects.toThrow(
      "process.exit called",
    );

    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("✗"));
  });
});
