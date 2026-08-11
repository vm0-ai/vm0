import { describe, expect, it } from "vitest";
import { desktopProductFromClientHeader } from "../client-headers";
import {
  computerUseCommandErrorCodeSchema,
  computerUseHostCommandCompleteBodySchema,
  computerUseHostSchema,
  zeroComputerUseCommandContract,
  zeroComputerUseWriteCommandContract,
} from "../zero-computer-use";

describe("computer-use contract", () => {
  it("accepts legacy host responses without product identity", () => {
    const host = computerUseHostSchema.parse({
      id: "host-id",
      displayName: "Studio Mac",
      appVersion: "1.0.0",
      osVersion: "macOS 15",
      supportedCapabilities: [],
      permissions: { accessibility: true, screenRecording: true },
      status: "online",
      lastSeenAt: "2026-08-11T00:00:00.000Z",
      createdAt: "2026-08-11T00:00:00.000Z",
    });

    expect(desktopProductFromClientHeader(host.product)).toBe("zero");
  });

  it("defaults command timeout to 60 seconds and allows up to 120 seconds", () => {
    expect(
      zeroComputerUseCommandContract.create.body.parse({
        kind: "apps.list",
      }).timeoutMs,
    ).toBe(60_000);
    expect(
      zeroComputerUseWriteCommandContract.create.body.parse({
        kind: "app.open",
        app: "Safari",
        timeoutMs: 120_000,
      }).timeoutMs,
    ).toBe(120_000);
    expect(() => {
      zeroComputerUseCommandContract.create.body.parse({
        kind: "apps.list",
        timeoutMs: 120_001,
      });
    }).toThrow();
  });

  it.each([
    "app_not_found",
    "app_open_failed",
    "automation_permission_denied",
    "element_not_editable",
    "window_unavailable",
  ])("accepts %s command failures", (code) => {
    expect(computerUseCommandErrorCodeSchema.parse(code)).toBe(code);
    expect(
      computerUseHostCommandCompleteBodySchema.parse({
        status: "failed",
        error: {
          code,
          message: "Unable to open Things",
        },
      }),
    ).toStrictEqual({
      status: "failed",
      error: {
        code,
        message: "Unable to open Things",
      },
    });
  });
});
