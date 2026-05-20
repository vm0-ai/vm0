import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveLocalAgentApiBaseUrl,
  type DesktopLocalAgentApiClient,
} from "./desktop-local-agent-api";
import { DesktopLocalAgentManager } from "./desktop-local-agent-manager";
import type {
  executeLocalAgentBackend,
  preflightLocalAgentBackend,
} from "./desktop-local-agent-runtime";
import type {
  DesktopLocalAgentBackendProbe,
  DesktopLocalAgentEntry,
} from "./desktop-local-agent-types";

const CODEX_PROBES: DesktopLocalAgentBackendProbe[] = [
  {
    backend: "codex",
    command: "codex",
    available: true,
    executablePath: "/opt/homebrew/bin/codex",
    version: "codex 1.0.0",
  },
  {
    backend: "claude-code",
    command: "claude",
    available: true,
    executablePath: "/opt/homebrew/bin/claude",
    version: "claude 1.0.0",
  },
];

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  tempRoots = [];
});

function createWorkspace(name: string): string {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "desktop-agent-"));
  const workspacePath = path.join(tempRoot, name);
  mkdirSync(workspacePath, { recursive: true });
  tempRoots.push(tempRoot);
  return workspacePath;
}

function createHarness(
  options: {
    readonly folders?: readonly string[];
    readonly initialEntries?: readonly DesktopLocalAgentEntry[];
    readonly apiOverrides?: Partial<DesktopLocalAgentApiClient>;
    readonly preflightBackend?: typeof preflightLocalAgentBackend;
    readonly executeBackend?: typeof executeLocalAgentBackend;
  } = {},
) {
  let entries = [...(options.initialEntries ?? [])];
  const harnessFolders = options.folders ?? [createWorkspace("alpha")];
  const folders = [...harnessFolders];
  const startedHosts: string[] = [];
  const closedHosts: string[] = [];
  const deletedHosts: string[] = [];
  const completedJobs: Array<{
    readonly jobId: string;
    readonly status: "succeeded" | "failed";
    readonly error: string | undefined;
    readonly signalAborted: boolean;
  }> = [];
  const api: DesktopLocalAgentApiClient = {
    async startHost(params) {
      startedHosts.push(params.hostName);
      return {
        hostId: `host-${startedHosts.length}`,
        hostToken: `token-${startedHosts.length}`,
      };
    },
    async heartbeat() {},
    async claimNextJob() {
      return { status: "idle" };
    },
    async completeJob(params) {
      completedJobs.push({
        jobId: params.jobId,
        status: params.status,
        error: params.error,
        signalAborted: params.signal?.aborted ?? false,
      });
    },
    async closeHost(params) {
      closedHosts.push(params.hostToken);
    },
    async deleteHost(params) {
      deletedHosts.push(params.hostId);
    },
  };
  const manager = new DesktopLocalAgentManager({
    store: {
      async load() {
        return entries;
      },
      async save(nextEntries) {
        entries = [...nextEntries];
      },
    },
    api: { ...api, ...options.apiOverrides },
    async selectFolder() {
      return folders.shift() ?? null;
    },
    async openFolder() {},
    detectBackends: vi.fn(async () => {
      return CODEX_PROBES;
    }),
    preflightBackend:
      options.preflightBackend ??
      vi.fn(async (backend) => {
        return {
          backend,
          command: backend === "codex" ? "codex" : "claude",
          executablePath:
            backend === "codex"
              ? "/opt/homebrew/bin/codex"
              : "/opt/homebrew/bin/claude",
          runtimePath: "/opt/homebrew/bin:/usr/bin:/bin",
          version: `${backend} 1.0.0`,
        };
      }),
    executeBackend:
      options.executeBackend ??
      vi.fn(async () => {
        return { output: "ok", exitCode: 0 };
      }),
    randomId: vi
      .fn()
      .mockReturnValueOnce("agent-1")
      .mockReturnValueOnce("agent-2"),
  });

  return {
    manager,
    startedHosts,
    closedHosts,
    deletedHosts,
    completedJobs,
    folders: harnessFolders,
  };
}

describe("DesktopLocalAgentApiClient", () => {
  it("derives the API backend URL from PR preview platform URLs", () => {
    expect(
      resolveLocalAgentApiBaseUrl(
        new URL("https://pr-123-app.vm6.ai"),
      ).toString(),
    ).toBe("https://pr-123-api.vm6.ai/");
  });
});

describe("DesktopLocalAgentManager", () => {
  it("keeps native access disabled until the feature switch enables it", async () => {
    const { manager } = createHarness();

    await expect(manager.list()).rejects.toThrow("disabled");
    await expect(manager.stop("agent-1")).rejects.toThrow("disabled");
    await expect(manager.remove("agent-1")).rejects.toThrow("disabled");
    await manager.setEnabled(true);

    await expect(manager.list()).resolves.toStrictEqual([]);
  });

  it("adds a Codex workspace with workspace-write permissions by default", async () => {
    const { manager, startedHosts, closedHosts, deletedHosts, folders } =
      createHarness();

    await manager.setEnabled(true);
    const entry = await manager.add();

    expect(entry).toMatchObject({
      id: "agent-1",
      name: "alpha",
      folderPath: folders[0],
      backend: "codex",
      permissionMode: "workspace-write",
      status: "online",
      hostId: "host-1",
      executablePath: "/opt/homebrew/bin/codex",
    });
    expect(startedHosts).toStrictEqual(["alpha"]);

    await manager.stopAll();
    expect(closedHosts).toStrictEqual(["token-1"]);
    expect(deletedHosts).toStrictEqual([]);
  });

  it("runs multiple configured workspaces independently", async () => {
    const { manager, startedHosts, closedHosts, deletedHosts } = createHarness({
      folders: [createWorkspace("alpha"), createWorkspace("beta")],
    });

    await manager.setEnabled(true);
    await manager.add();
    await manager.add();

    expect(startedHosts).toStrictEqual(["alpha", "beta"]);
    expect(await manager.list()).toMatchObject([
      { name: "alpha", status: "online" },
      { name: "beta", status: "online" },
    ]);

    await manager.stop("agent-1");
    expect(await manager.list()).toMatchObject([
      { name: "alpha", status: "stopped" },
      { name: "beta", status: "online" },
    ]);
    expect(closedHosts).toStrictEqual(["token-1"]);

    await manager.stopAll();
    expect(closedHosts).toStrictEqual(["token-1", "token-2"]);
    expect(deletedHosts).toStrictEqual([]);
  });

  it("restores persisted agents as stopped without autostarting them", async () => {
    const folderPath = createWorkspace("alpha");
    const { manager, startedHosts } = createHarness({
      initialEntries: [
        {
          id: "agent-1",
          name: "alpha",
          folderPath,
          backend: "codex",
          permissionMode: "workspace-write",
          status: "online",
          hostId: "host-1",
          lastHeartbeatAt: "2026-05-19T00:00:00.000Z",
        },
      ],
    });

    await manager.setEnabled(true);

    expect(await manager.list()).toStrictEqual([
      {
        id: "agent-1",
        name: "alpha",
        folderPath,
        backend: "codex",
        permissionMode: "workspace-write",
        status: "stopped",
        hostId: "host-1",
        lastHeartbeatAt: "2026-05-19T00:00:00.000Z",
      },
    ]);
    expect(startedHosts).toStrictEqual([]);
  });

  it("does not advertise a host when backend preflight fails", async () => {
    const preflightBackend = vi.fn<typeof preflightLocalAgentBackend>(
      async () => {
        throw new Error("Codex not found");
      },
    );
    const { manager, startedHosts } = createHarness({ preflightBackend });

    await manager.setEnabled(true);
    const entry = await manager.add({ backend: "codex" });

    expect(entry).toMatchObject({
      id: "agent-1",
      status: "error",
      errorMessage: "Codex not found",
    });
    expect(startedHosts).toStrictEqual([]);
    await expect(manager.list()).resolves.toMatchObject([
      {
        id: "agent-1",
        status: "error",
        errorMessage: "Codex not found",
      },
    ]);
  });

  it("revokes the server host before removing a Desktop local agent", async () => {
    const folderPath = createWorkspace("alpha");
    const { manager, closedHosts, deletedHosts } = createHarness({
      initialEntries: [
        {
          id: "agent-1",
          name: "alpha",
          folderPath,
          backend: "codex",
          permissionMode: "workspace-write",
          status: "stopped",
          hostId: "host-1",
        },
      ],
    });

    await manager.setEnabled(true);
    await manager.remove("agent-1");

    await expect(manager.list()).resolves.toStrictEqual([]);
    expect(closedHosts).toStrictEqual([]);
    expect(deletedHosts).toStrictEqual(["host-1"]);
  });

  it("keeps the local entry visible when server host deletion fails", async () => {
    const folderPath = createWorkspace("alpha");
    const deletionAttempts: string[] = [];
    const { manager } = createHarness({
      initialEntries: [
        {
          id: "agent-1",
          name: "alpha",
          folderPath,
          backend: "codex",
          permissionMode: "workspace-write",
          status: "stopped",
          hostId: "host-1",
        },
      ],
      apiOverrides: {
        async deleteHost(params) {
          deletionAttempts.push(params.hostId);
          throw new Error("Local-agent host not found");
        },
      },
    });

    await manager.setEnabled(true);
    await expect(manager.remove("agent-1")).rejects.toThrow(
      "Local-agent host not found",
    );

    await expect(manager.list()).resolves.toMatchObject([
      {
        id: "agent-1",
        status: "error",
        errorMessage: "Local-agent host not found",
      },
    ]);
    expect(deletionAttempts).toStrictEqual(["host-1"]);
  });

  it("removes local-only entries without calling server delete", async () => {
    const folderPath = createWorkspace("alpha");
    const { manager, deletedHosts } = createHarness({
      initialEntries: [
        {
          id: "agent-1",
          name: "alpha",
          folderPath,
          backend: "codex",
          permissionMode: "workspace-write",
          status: "stopped",
        },
      ],
    });

    await manager.setEnabled(true);
    await manager.remove("agent-1");

    await expect(manager.list()).resolves.toStrictEqual([]);
    expect(deletedHosts).toStrictEqual([]);
  });

  it("uses the resolved executable path for jobs", async () => {
    let claimCount = 0;
    const executeBackend = vi.fn<typeof executeLocalAgentBackend>(async () => {
      return { output: "ok", exitCode: 0 };
    });
    const { manager } = createHarness({
      executeBackend,
      apiOverrides: {
        async claimNextJob() {
          claimCount += 1;
          if (claimCount === 1) {
            return {
              status: "job",
              job: {
                id: "job-1",
                backend: "codex",
                prompt: "run task",
              },
            };
          }
          return { status: "idle" };
        },
      },
    });

    await manager.setEnabled(true);
    await manager.add();
    await vi.waitFor(() => {
      expect(executeBackend).toHaveBeenCalled();
    });

    expect(executeBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        executablePath: "/opt/homebrew/bin/codex",
        runtimePath: "/opt/homebrew/bin:/usr/bin:/bin",
      }),
    );

    await manager.stopAll();
  });

  it("fails an active job before closing the host when stopped", async () => {
    let claimCount = 0;
    const executeBackend = vi.fn<typeof executeLocalAgentBackend>(
      async (params) => {
        return await new Promise((resolve) => {
          params.signal?.addEventListener(
            "abort",
            () => {
              resolve({
                output: "",
                error: "Local agent job was stopped",
                exitCode: 1,
              });
            },
            { once: true },
          );
        });
      },
    );
    const { manager, closedHosts, deletedHosts, completedJobs } = createHarness(
      {
        executeBackend,
        apiOverrides: {
          async claimNextJob() {
            claimCount += 1;
            if (claimCount === 1) {
              return {
                status: "job",
                job: {
                  id: "job-1",
                  backend: "codex",
                  prompt: "run task",
                },
              };
            }
            return { status: "idle" };
          },
        },
      },
    );

    await manager.setEnabled(true);
    await manager.add();
    await vi.waitFor(() => {
      expect(executeBackend).toHaveBeenCalled();
    });

    await manager.stop("agent-1");

    expect(completedJobs).toStrictEqual([
      {
        jobId: "job-1",
        status: "failed",
        error: "Local agent job was stopped",
        signalAborted: false,
      },
    ]);
    expect(closedHosts).toStrictEqual(["token-1"]);
    expect(deletedHosts).toStrictEqual([]);
  });
});
