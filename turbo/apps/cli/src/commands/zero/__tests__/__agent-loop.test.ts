import { afterEach, expect, it, vi } from "vitest";

import { zeroAgentLoopCommand } from "../__agent-loop";

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("rejects a legacy-only run id without exposing its value", async () => {
  const legacyRunId = "legacy-sensitive-run-id";
  vi.stubEnv("OKOU_RUN_ID", "");
  vi.stubEnv("VM0_RUN_ID", legacyRunId);
  vi.stubEnv("OKOU_PI_SESSION_ID", "11111111-1111-4111-8111-111111111111");
  vi.stubEnv("OKOU_PI_SYSTEM_PROMPT", "system prompt");
  vi.stubEnv(
    "OKOU_PI_MODEL_CONFIG",
    JSON.stringify({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-v4-flash",
      apiKeyEnv: "OPENAI_API_KEY",
    }),
  );
  vi.stubEnv("OPENAI_API_KEY", "test-api-key");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  await zeroAgentLoopCommand.parseAsync(["node", "okou"]);

  expect(process.exitCode).toBe(1);
  expect(consoleError).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalledWith(
    "OKOU_RUN_ID is required for Pi execution",
  );
  const stderr = consoleError.mock.calls.flat().join("\n");
  expect(stderr).not.toContain(legacyRunId);
});
