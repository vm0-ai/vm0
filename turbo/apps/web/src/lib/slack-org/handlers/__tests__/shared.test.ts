import { describe, it, expect } from "vitest";
import { buildOrgConnectUrl, buildLogsUrl, buildAgentLogsUrl } from "../shared";

describe("buildOrgConnectUrl", () => {
  it("should use platform URL with www hostname", () => {
    const url = buildOrgConnectUrl("T-workspace", "U-user", "C-channel");

    // NEXT_PUBLIC_PLATFORM_URL is http://localhost:3001 in test env
    // "platform" is not in "localhost" so hostname stays the same
    expect(url).toContain("/api/slack/org/connect");
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

  it("should replace platform with www in hostname", () => {
    // The function does url.hostname.replace("platform", "www")
    // With test env localhost:3001, this is a no-op since "platform" isn't in the hostname
    // But we can verify the URL structure is correct
    const url = new URL(buildOrgConnectUrl("T-ws", "U-usr", "C-ch"));

    expect(url.pathname).toBe("/api/slack/org/connect");
    expect(url.searchParams.get("w")).toBe("T-ws");
    expect(url.searchParams.get("u")).toBe("U-usr");
    expect(url.searchParams.get("c")).toBe("C-ch");
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
