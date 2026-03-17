import { describe, it, expect } from "vitest";
import { buildOrgConnectUrl, buildLogsUrl, buildAgentLogsUrl } from "../shared";

describe("buildOrgConnectUrl", () => {
  it("should point to platform slack connect page", () => {
    const url = buildOrgConnectUrl("T-workspace", "U-user", "C-channel");

    expect(url).toContain("/slack/connect");
    expect(url).toContain("w=T-workspace");
    expect(url).toContain("u=U-user");
    expect(url).toContain("c=C-channel");
  });

  it("should include threadTs when provided", () => {
    const url = buildOrgConnectUrl(
      "T-workspace",
      "U-user",
      "C-channel",
      "1234567890.123456",
    );

    expect(url).toContain("t=1234567890.123456");
  });

  it("should not include threadTs param when not provided", () => {
    const url = buildOrgConnectUrl("T-workspace", "U-user", "C-channel");

    expect(url).not.toContain("&t=");
  });

  it("should not include empty channelId", () => {
    const url = buildOrgConnectUrl("T-ws", "U-usr", "");

    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/slack/connect");
    expect(parsed.searchParams.get("w")).toBe("T-ws");
    expect(parsed.searchParams.get("u")).toBe("U-usr");
    expect(parsed.searchParams.has("c")).toBe(false);
  });
});

describe("buildLogsUrl", () => {
  it("should return platform URL with zero/activity path", () => {
    const url = buildLogsUrl("run-123");

    expect(url).toBe("http://localhost:3001/zero/activity/run-123");
  });

  it("should encode run ID in URL", () => {
    const url = buildLogsUrl("run/with/slashes");

    expect(url).toBe(
      "http://localhost:3001/zero/activity/run%2Fwith%2Fslashes",
    );
  });
});

describe("buildAgentLogsUrl", () => {
  it("should return platform URL with zero/activity path", () => {
    const url = buildAgentLogsUrl();

    expect(url).toBe("http://localhost:3001/zero/activity");
  });
});
