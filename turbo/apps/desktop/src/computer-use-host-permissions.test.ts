import { beforeEach, expect, it, vi } from "vitest";
import { createComputerUseHostPermissions } from "./computer-use-host-permissions";

const os = vi.hoisted(() => ({
  isTrustedAccessibilityClient: vi.fn<(prompt: boolean) => boolean>(
    () => false,
  ),
  getMediaAccessStatus: vi.fn<() => string>(() => "denied"),
  openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}),
}));
vi.mock("electron", () => ({ systemPreferences: os, shell: os }));
beforeEach(() => vi.clearAllMocks());

it("reads host TCC without prompting and reserves OS requests for explicit actions", async () => {
  const permissions = createComputerUseHostPermissions("darwin");
  expect(await permissions.getPermissions()).toStrictEqual({
    accessibility: false,
    screenRecording: false,
  });
  expect(os.isTrustedAccessibilityClient.mock.calls).toStrictEqual([[false]]);
  expect(os.getMediaAccessStatus).toHaveBeenCalledWith("screen");
  expect(os.openExternal).not.toHaveBeenCalled();
  await permissions.requestAccessibilityPermission();
  expect(os.isTrustedAccessibilityClient.mock.calls).toStrictEqual([
    [false],
    [true],
    [false],
  ]);
  await permissions.requestScreenRecordingPermission();
  expect(os.openExternal).toHaveBeenCalledExactlyOnceWith(
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  );
  os.isTrustedAccessibilityClient.mockReturnValue(true);
  os.getMediaAccessStatus.mockReturnValue("granted");
  expect(await permissions.getPermissions()).toStrictEqual({
    accessibility: true,
    screenRecording: true,
  });
  expect(await permissions.probeAutomationPermission("chrome")).toMatchObject({
    status: "unknown",
  });
});
