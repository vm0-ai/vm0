import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";

type DesktopLocalAgentApi = NonNullable<Window["vm0DesktopLocalAgent"]>;
export type DesktopLocalAgentEntry = Awaited<
  ReturnType<DesktopLocalAgentApi["list"]>
>[number];
type DesktopLocalAgentBackendProbe = Awaited<
  ReturnType<DesktopLocalAgentApi["detectBackends"]>
>[number];
export type DesktopLocalAgentBackend = DesktopLocalAgentEntry["backend"];
export type DesktopLocalAgentPermissionMode =
  DesktopLocalAgentEntry["permissionMode"];

interface DesktopLocalAgentData {
  readonly entries: readonly DesktopLocalAgentEntry[];
  readonly probes: readonly DesktopLocalAgentBackendProbe[];
}

const internalReload$ = state(0);
const internalDialogOpen$ = state(false);
const internalSelectedBackend$ = state<DesktopLocalAgentBackend>("codex");
const internalPermissionMode$ =
  state<DesktopLocalAgentPermissionMode>("workspace-write");

function desktopLocalAgentApi(): DesktopLocalAgentApi {
  const api = window.vm0DesktopLocalAgent;
  if (!api) {
    throw new Error("Zero Desktop local agent bridge is unavailable");
  }
  return api;
}

function defaultPermissionForBackend(
  backend: DesktopLocalAgentBackend,
): DesktopLocalAgentPermissionMode {
  return backend === "codex" ? "workspace-write" : "default";
}

export const desktopLocalAgentData$ = computed(
  async (get): Promise<DesktopLocalAgentData> => {
    get(internalReload$);
    const api = desktopLocalAgentApi();
    const [entries, probes] = await Promise.all([
      api.list(),
      api.detectBackends(),
    ]);
    return { entries, probes };
  },
);

export const desktopLocalAgentDialogOpen$ = computed((get) => {
  return get(internalDialogOpen$);
});

export const desktopLocalAgentSelectedBackend$ = computed((get) => {
  return get(internalSelectedBackend$);
});

export const desktopLocalAgentPermissionMode$ = computed((get) => {
  return get(internalPermissionMode$);
});

export const setDesktopLocalAgentDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalDialogOpen$, open);
  },
);

export const setDesktopLocalAgentSelectedBackend$ = command(
  ({ set }, backend: DesktopLocalAgentBackend) => {
    set(internalSelectedBackend$, backend);
    set(internalPermissionMode$, defaultPermissionForBackend(backend));
  },
);

export const setDesktopLocalAgentPermissionMode$ = command(
  ({ set }, permissionMode: DesktopLocalAgentPermissionMode) => {
    set(internalPermissionMode$, permissionMode);
  },
);

export const setupDesktopLocalAgentBridge$ = command(
  async ({ set }, signal: AbortSignal) => {
    const api = desktopLocalAgentApi();
    await api.setEnabled(true);
    signal.throwIfAborted();

    const unsubscribe = api.subscribe(() => {
      set(internalReload$, (previous) => {
        return previous + 1;
      });
    });
    signal.addEventListener("abort", unsubscribe, { once: true });
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);

export const runDesktopLocalAgentAction$ = command(
  async (
    { set },
    params: {
      readonly id: string;
      readonly action: "start" | "stop" | "openFolder" | "remove";
    },
    signal: AbortSignal,
  ) => {
    const api = desktopLocalAgentApi();
    if (params.action === "start") {
      await api.start(params.id);
    } else if (params.action === "stop") {
      await api.stop(params.id);
    } else if (params.action === "openFolder") {
      await api.openFolder(params.id);
    } else {
      await api.remove(params.id);
    }
    signal.throwIfAborted();
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);

export const addDesktopLocalAgent$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const entry = await desktopLocalAgentApi().add({
      backend: get(internalSelectedBackend$),
      permissionMode: get(internalPermissionMode$),
    });
    signal.throwIfAborted();
    set(internalDialogOpen$, false);
    if (entry) {
      toast.success(`${entry.name} started`);
    }
    set(internalReload$, (previous) => {
      return previous + 1;
    });
  },
);
