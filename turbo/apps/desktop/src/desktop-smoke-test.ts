const DESKTOP_SMOKE_TEST_ENV = "VM0_DESKTOP_SMOKE_TEST";

export const DESKTOP_SMOKE_TEST_READY_MARKER =
  "[smoke-test] desktop main ready";

export function isDesktopSmokeTestEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[DESKTOP_SMOKE_TEST_ENV] === "1";
}
