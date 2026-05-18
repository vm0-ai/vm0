import type { LocalAgentHost } from "@vm0/api-contracts/contracts/zero-local-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockApiRequestError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(message: string, code: string, status: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  return {
    ApiRequestError: MockApiRequestError,
    claimNextLocalAgentHostJob: vi.fn(),
    closeLocalAgentHost: vi.fn(),
    completeLocalAgentHostJob: vi.fn(),
    createLocalAgentHostRealtimeSubscription: vi.fn(),
    isInteractive: vi.fn(),
    listLocalAgentHosts: vi.fn(),
    promptSelect: vi.fn(),
    promptText: vi.fn(),
    sendLocalAgentHeartbeat: vi.fn(),
    startLocalAgentHost: vi.fn(),
  };
});

vi.mock("../../../../lib/api", () => {
  return {
    ApiRequestError: mocks.ApiRequestError,
    claimNextLocalAgentHostJob: mocks.claimNextLocalAgentHostJob,
    closeLocalAgentHost: mocks.closeLocalAgentHost,
    completeLocalAgentHostJob: mocks.completeLocalAgentHostJob,
    createLocalAgentHostRealtimeSubscription:
      mocks.createLocalAgentHostRealtimeSubscription,
    listLocalAgentHosts: mocks.listLocalAgentHosts,
    sendLocalAgentHeartbeat: mocks.sendLocalAgentHeartbeat,
    startLocalAgentHost: mocks.startLocalAgentHost,
  };
});

vi.mock("../../../../lib/utils/prompt-utils", () => {
  return {
    isInteractive: mocks.isInteractive,
    promptSelect: mocks.promptSelect,
    promptText: mocks.promptText,
  };
});

describe("local-agent host start selection", () => {
  const closedHost = {
    id: "host-closed",
    displayName: "laptop",
    supportedBackends: ["codex"],
    status: "closed",
    lastSeenAt: "2026-05-18T00:00:00.000Z",
    createdAt: "2026-05-18T00:00:00.000Z",
  } satisfies LocalAgentHost;

  beforeEach(() => {
    mocks.claimNextLocalAgentHostJob.mockReset();
    mocks.closeLocalAgentHost.mockReset();
    mocks.completeLocalAgentHostJob.mockReset();
    mocks.createLocalAgentHostRealtimeSubscription.mockReset();
    mocks.isInteractive.mockReset();
    mocks.listLocalAgentHosts.mockReset();
    mocks.promptSelect.mockReset();
    mocks.promptText.mockReset();
    mocks.sendLocalAgentHeartbeat.mockReset();
    mocks.startLocalAgentHost.mockReset();
  });

  it("restores a closed host when its name is typed from the new host prompt", async () => {
    mocks.listLocalAgentHosts.mockResolvedValue({ hosts: [closedHost] });
    mocks.isInteractive.mockReturnValue(true);
    mocks.promptSelect.mockResolvedValue("__new__");
    mocks.promptText.mockImplementation(
      async (
        _message: string,
        _initial: string | undefined,
        validate?: (value: string) => boolean | string,
      ) => {
        expect(validate?.("laptop")).toBe(true);
        return "laptop";
      },
    );
    const { chooseHostForStart } = await import("../host");

    const selection = await chooseHostForStart({});

    expect(selection).toStrictEqual({
      hostId: "host-closed",
      hostName: "laptop",
      restoredHost: closedHost,
    });
  });
});
