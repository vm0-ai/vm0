import { describe, it, expect, vi } from "vitest";

describe("computer connector - ngrok integration", () => {
  it("should call ngrok.forward twice with correct parameters", async () => {
    const mockForward = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@ngrok/ngrok", () => ({
      default: {
        forward: mockForward,
      },
    }));

    const { startNgrokTunnels } = await import("../lib/computer/ngrok");

    await startNgrokTunnels("test-token", "test-prefix", 12345, 9222);

    expect(mockForward).toHaveBeenCalledTimes(2);
    expect(mockForward).toHaveBeenCalledWith({
      addr: "localhost:12345",
      authtoken: "test-token",
      domain: "webdav.test-prefix.internal",
    });
    expect(mockForward).toHaveBeenCalledWith({
      addr: "localhost:9222",
      authtoken: "test-token",
      domain: "chrome.test-prefix.internal",
    });
  });
});
