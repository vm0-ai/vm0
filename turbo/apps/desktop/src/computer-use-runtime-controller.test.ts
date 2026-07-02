import { describe, expect, it, vi } from "vitest";
import { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import {
  OFFLINE_COMPUTER_USE_HOST_STATE,
  type ComputerUseHostRuntimeState,
  type ComputerUsePermissionState,
} from "./computer-use-types";
import type { DesktopAuthState } from "./desktop-bridge";

const GRANTED_PERMISSIONS: ComputerUsePermissionState = {
  accessibility: true,
  screenRecording: true,
};

const SIGNED_IN_AUTH_STATE: DesktopAuthState = {
  status: "signed_in",
  user: { userId: "user-1", email: "user@vm0.ai" },
  organization: { id: "org-1", name: "vm0", slug: null },
};

function hostState(
  status: ComputerUseHostRuntimeState["status"],
): ComputerUseHostRuntimeState {
  return { ...OFFLINE_COMPUTER_USE_HOST_STATE, status };
}

function createFakeRuntime(options: { readonly hangOnStop?: boolean } = {}) {
  let state = hostState("offline");
  return {
    start: vi.fn(async () => {
      state = hostState("online");
    }),
    stop: vi.fn(async () => {
      if (options.hangOnStop) {
        await new Promise<void>(() => {});
      }
      state = hostState("offline");
    }),
    getState: () => state,
  };
}

function createController(
  overrides: {
    readonly runtime?: ReturnType<typeof createFakeRuntime>;
    readonly permissions?: ComputerUsePermissionState;
    readonly authState?: DesktopAuthState;
    readonly quitStopTimeoutMs?: number;
  } = {},
) {
  const runtime = overrides.runtime ?? createFakeRuntime();
  const createRuntime = vi.fn(() => runtime);
  const refreshPermissions = vi.fn(
    async () => overrides.permissions ?? GRANTED_PERMISSIONS,
  );
  const getAuthState = vi.fn(
    async () => overrides.authState ?? SIGNED_IN_AUTH_STATE,
  );
  const setHostRuntimeOnline = vi.fn();
  const onChange = vi.fn();
  const controller = new ComputerUseRuntimeController({
    createRuntime,
    refreshPermissions,
    getAuthState,
    setHostRuntimeOnline,
    onChange,
    quitStopTimeoutMs: overrides.quitStopTimeoutMs,
  });
  return {
    controller,
    runtime,
    createRuntime,
    refreshPermissions,
    getAuthState,
    setHostRuntimeOnline,
    onChange,
  };
}

describe("ComputerUseRuntimeController", () => {
  it("starts the runtime when the startup gate is ready", async () => {
    const { controller, runtime, setHostRuntimeOnline } = createController();

    await controller.start();

    expect(runtime.start).toHaveBeenCalledOnce();
    expect(controller.getHostState().status).toBe("online");
    expect(controller.isRuntimeOnline()).toBe(true);
    expect(setHostRuntimeOnline).toHaveBeenLastCalledWith(true);
  });

  it("does not create a runtime when permissions are missing", async () => {
    const { controller, createRuntime, onChange } = createController({
      permissions: { accessibility: false, screenRecording: false },
    });

    await controller.start();

    expect(createRuntime).not.toHaveBeenCalled();
    expect(controller.getHostState().status).toBe("offline");
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("records a blocked host state when signed out", async () => {
    const { controller, createRuntime } = createController({
      authState: { status: "signed_out", user: null, organization: null },
    });

    await controller.start();

    expect(createRuntime).not.toHaveBeenCalled();
    expect(controller.getHostState().status).toBe("unauthenticated");
  });

  it("stops a running runtime when the startup gate blocks", async () => {
    const { controller, runtime, getAuthState } = createController();
    await controller.start();

    getAuthState.mockResolvedValue({
      status: "signed_out",
      user: null,
      organization: null,
    });
    await controller.start();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(controller.getHostState().status).toBe("unauthenticated");
  });

  it("suppresses non-user-initiated starts after a manual stop", async () => {
    const { controller, runtime, createRuntime, onChange } = createController();
    await controller.start();
    await controller.stop();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalled();

    await controller.start();
    expect(runtime.start).toHaveBeenCalledOnce();

    await controller.start({ userInitiated: true });
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it("detaches on auth change so the next start builds a fresh runtime", async () => {
    const { controller, runtime, createRuntime, onChange } = createController();
    await controller.start();

    await controller.stopForAuthChange();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(controller.getHostState().status).toBe("offline");
    expect(onChange).toHaveBeenCalled();

    await controller.start();
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it("stops for quit exactly once across quit paths", async () => {
    const { controller, runtime, setHostRuntimeOnline } = createController();
    await controller.start();
    expect(controller.quitStopRequired()).toBe(true);

    await controller.stopForQuit();
    await controller.stopForQuit();

    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(controller.quitStopRequired()).toBe(false);
    expect(setHostRuntimeOnline).toHaveBeenLastCalledWith(false);
  });

  it("does not require a quit stop without a runtime", async () => {
    const { controller, setHostRuntimeOnline } = createController();

    expect(controller.quitStopRequired()).toBe(false);
    await controller.stopForQuit();
    expect(setHostRuntimeOnline).not.toHaveBeenCalled();
  });

  it("bounds the quit stop by the timeout when the runtime hangs", async () => {
    const runtime = createFakeRuntime({ hangOnStop: true });
    const { controller } = createController({
      runtime,
      quitStopTimeoutMs: 1,
    });
    await controller.start();

    await controller.stopForQuit();

    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});
