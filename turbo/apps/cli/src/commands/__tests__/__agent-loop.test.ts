import { afterEach, expect, it, vi } from "vitest";
import { agentLoopCommand } from "../__agent-loop";

const previousExit = process.exitCode;

afterEach(() => {
  process.exitCode = previousExit;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps a failed command terminal when its stderr sink throws", async () => {
  vi.stubEnv("OKOU_RUN_ID", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => {
    throw new Error("PRIVATE_SINK_SENTINEL");
  });
  await expect(
    agentLoopCommand.parseAsync(["node", "okou"]),
  ).resolves.toBeDefined();
  expect(log).toHaveBeenCalledWith("OKOU_RUN_ID is required for Pi execution");
  expect(process.exitCode).toBe(1);
});
