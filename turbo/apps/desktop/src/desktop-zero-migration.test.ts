import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZERO_MIGRATION_BRIDGE_CONFIG } from "./desktop-zero-migration-config";
import { DesktopZeroMigrationController } from "./desktop-zero-migration";

const directories: string[] = [];

async function preferencesPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zero-migration-"));
  directories.push(directory);
  return path.join(directory, "desktop-preferences.json");
}

function createController(options: {
  readonly filePath: string;
  readonly enabled?: boolean;
  readonly product?: "zero" | "okou";
  readonly appVersion?: string;
  readonly now?: () => number;
  readonly drainAndStopZero?: () => Promise<void>;
  readonly startZero?: () => Promise<void>;
  readonly openDownload?: (url: string) => Promise<void>;
  readonly fetchPolicy?: (signal: AbortSignal) => Promise<Response>;
  readonly quitZero?: () => void;
  readonly onChange?: () => void;
  readonly onAttention?: () => void;
  readonly logPolicyError?: (error: unknown) => void;
}) {
  return new DesktopZeroMigrationController({
    enabled: options.enabled ?? true,
    product: options.product ?? "zero",
    appVersion: options.appVersion ?? "0.34.0",
    preferencesPath: options.filePath,
    drainAndStopZero: options.drainAndStopZero ?? vi.fn(async () => {}),
    startZero: options.startZero ?? vi.fn(async () => {}),
    openDownload: options.openDownload ?? vi.fn(async () => {}),
    fetchPolicy:
      options.fetchPolicy ??
      vi.fn(async () => {
        return Response.json({ schemaVersion: 1, mode: "soft" });
      }),
    quitZero: options.quitZero ?? vi.fn(),
    onChange: options.onChange,
    onAttention: options.onAttention,
    logPolicyError: options.logPolicyError,
    now: options.now,
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("DesktopZeroMigrationController", () => {
  it("offers the bridge only to eligible Zero production versions", async () => {
    const filePath = await preferencesPath();

    expect(createController({ filePath }).getState().mode).toBe(
      "soft_reminder",
    );
    expect(
      createController({ filePath, product: "okou" }).getState().mode,
    ).toBe("hidden");
    expect(
      createController({ filePath, appVersion: "0.33.4" }).getState().mode,
    ).toBe("hidden");
    expect(createController({ filePath, enabled: false }).getState().mode).toBe(
      "hidden",
    );
  });

  it("persists a seven-day reminder deferral without stopping Zero", async () => {
    const filePath = await preferencesPath();
    const now = Date.parse("2026-08-12T00:00:00.000Z");
    const drainAndStopZero = vi.fn(async () => {});
    const controller = createController({
      filePath,
      now: () => now,
      drainAndStopZero,
    });

    const state = controller.remindLater();

    expect(state).toEqual({
      mode: "hidden",
      nextReminderAt: new Date(
        now + ZERO_MIGRATION_BRIDGE_CONFIG.reminderDelayMs,
      ).toISOString(),
      errorMessage: null,
    });
    expect(drainAndStopZero).not.toHaveBeenCalled();
  });

  it("persists suppression, drains Zero, then opens the stable Okou route", async () => {
    const filePath = await preferencesPath();
    const events: string[] = [];
    const drain = vi.fn(async () => {
      events.push("drain");
    });
    const openDownload = vi.fn(async () => {
      events.push("download");
    });
    const controller = createController({
      filePath,
      drainAndStopZero: drain,
      openDownload,
    });

    const state = await controller.beginMigration();

    expect(drain).toHaveBeenCalledOnce();
    expect(openDownload).toHaveBeenCalledWith(
      ZERO_MIGRATION_BRIDGE_CONFIG.downloadUrl,
    );
    expect(events).toStrictEqual(["drain", "download"]);
    expect(state.mode).toBe("paused");
    expect(controller.shouldSuppressAutoStart()).toBe(true);
    expect(createController({ filePath }).shouldSuppressAutoStart()).toBe(true);
  });

  it("waits for the drain before opening the download", async () => {
    const filePath = await preferencesPath();
    let finishDrain!: () => void;
    const drainAndStopZero = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
    });
    const openDownload = vi.fn(async () => {});
    const controller = createController({
      filePath,
      drainAndStopZero,
      openDownload,
    });

    const migration = controller.beginMigration();
    await Promise.resolve();
    expect(controller.getState().mode).toBe("waiting_for_command");
    expect(createController({ filePath }).shouldSuppressAutoStart()).toBe(true);
    expect(openDownload).not.toHaveBeenCalled();

    finishDrain();
    await migration;
    expect(openDownload).toHaveBeenCalledOnce();
  });

  it("keeps Zero paused on download failure and can resume it", async () => {
    const filePath = await preferencesPath();
    const startZero = vi.fn(async () => {});
    const controller = createController({
      filePath,
      startZero,
      openDownload: vi.fn(async () => {
        throw new Error("Download could not be opened");
      }),
    });

    expect((await controller.beginMigration()).mode).toBe("download_failed");
    expect(controller.shouldSuppressAutoStart()).toBe(true);

    const resumed = await controller.resumeZero();
    expect(startZero).toHaveBeenCalledOnce();
    expect(resumed.mode).toBe("soft_reminder");
    expect(controller.shouldSuppressAutoStart()).toBe(false);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted.zeroMigration).toBeUndefined();
  });

  it("applies a hard stop only after draining the current command", async () => {
    const filePath = await preferencesPath();
    let finishDrain!: () => void;
    const drainAndStopZero = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        finishDrain = resolve;
      });
    });
    const onAttention = vi.fn();
    const quitZero = vi.fn();
    const controller = createController({
      filePath,
      drainAndStopZero,
      onAttention,
      quitZero,
      fetchPolicy: vi.fn(async () => {
        return Response.json({ schemaVersion: 1, mode: "hard" });
      }),
    });

    const refresh = controller.refreshPolicy();
    await vi.waitFor(() => {
      expect(controller.getState().mode).toBe("hard_stop_waiting");
    });
    expect(controller.shouldSuppressAutoStart()).toBe(true);
    expect(controller.allowUserInitiatedStart()).toBe(false);
    expect(onAttention).toHaveBeenCalledOnce();

    finishDrain();
    await refresh;
    expect(controller.getState().mode).toBe("hard_stop");
    expect(controller.remindLater().mode).toBe("hard_stop");
    expect((await controller.resumeZero()).mode).toBe("hard_stop");

    controller.quitZero();
    expect(quitZero).toHaveBeenCalledOnce();
  });

  it("opens the Okou download without offering Zero recovery in hard mode", async () => {
    const filePath = await preferencesPath();
    const drainAndStopZero = vi.fn(async () => {});
    const openDownload = vi.fn(async () => {});
    const controller = createController({
      filePath,
      drainAndStopZero,
      openDownload,
      fetchPolicy: vi.fn(async () => {
        return Response.json({ schemaVersion: 1, mode: "hard" });
      }),
    });
    await controller.refreshPolicy();

    const state = await controller.beginMigration();

    expect(state.mode).toBe("hard_stop");
    expect(openDownload).toHaveBeenCalledWith(
      ZERO_MIGRATION_BRIDGE_CONFIG.downloadUrl,
    );
    expect(drainAndStopZero).toHaveBeenCalledTimes(2);
  });

  it("falls back to soft coexistence and restarts Zero when policy refresh fails", async () => {
    const filePath = await preferencesPath();
    const fetchPolicy = vi
      .fn<(signal: AbortSignal) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, mode: "hard" }))
      .mockRejectedValueOnce(new Error("Policy unavailable"));
    const startZero = vi.fn(async () => {});
    const logPolicyError = vi.fn();
    const controller = createController({
      filePath,
      fetchPolicy,
      startZero,
      logPolicyError,
    });
    await controller.refreshPolicy();

    await controller.refreshPolicy();

    expect(controller.getState().mode).toBe("soft_reminder");
    expect(controller.shouldSuppressAutoStart()).toBe(false);
    expect(startZero).toHaveBeenCalledOnce();
    expect(logPolicyError).toHaveBeenCalledOnce();
  });

  it("hides the reminder when the remote policy is off", async () => {
    const filePath = await preferencesPath();
    const controller = createController({
      filePath,
      fetchPolicy: vi.fn(async () => {
        return Response.json({ schemaVersion: 1, mode: "off" });
      }),
    });

    await controller.refreshPolicy();

    expect(controller.getState().mode).toBe("hidden");
    expect(controller.shouldSuppressAutoStart()).toBe(false);
  });
});
