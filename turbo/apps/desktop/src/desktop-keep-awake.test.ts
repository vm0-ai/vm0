import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopKeepAwakeController,
  type DesktopKeepAwakeBlocker,
} from "./desktop-keep-awake";

function createBlocker(): {
  readonly blocker: DesktopKeepAwakeBlocker;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
} {
  let nextId = 1;
  const activeIds = new Set<number>();
  const start = vi.fn(() => {
    const id = nextId;
    nextId += 1;
    activeIds.add(id);
    return id;
  });
  const stop = vi.fn((id: number) => {
    activeIds.delete(id);
  });
  return {
    start,
    stop,
    blocker: {
      start,
      stop,
      isStarted: (id) => activeIds.has(id),
    },
  };
}

async function createPreferencesPath(): Promise<{
  readonly directory: string;
  readonly preferencesPath: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vm0-desktop-"));
  return {
    directory,
    preferencesPath: path.join(directory, "desktop-preferences.json"),
  };
}

describe("DesktopKeepAwakeController", () => {
  it("defaults to disabled when no local preference exists", async () => {
    const { directory, preferencesPath } = await createPreferencesPath();
    const { blocker, start } = createBlocker();
    const onChange = vi.fn();
    const controller = new DesktopKeepAwakeController({
      preferencesPath,
      blocker,
      onChange,
    });

    try {
      expect(controller.load()).toStrictEqual({
        enabled: false,
        active: false,
      });
      expect(start).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts the system sleep blocker and persists the setting", async () => {
    const { directory, preferencesPath } = await createPreferencesPath();
    const { blocker, start } = createBlocker();
    const onChange = vi.fn();
    const controller = new DesktopKeepAwakeController({
      preferencesPath,
      blocker,
      onChange,
    });
    controller.load();

    try {
      expect(controller.setEnabled(true)).toStrictEqual({
        enabled: true,
        active: true,
      });
      expect(start).toHaveBeenCalledWith("prevent-app-suspension");
      expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toMatchObject(
        {
          keepAwakeEnabled: true,
        },
      );
      expect(onChange).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the blocker from persisted preferences", async () => {
    const { directory, preferencesPath } = await createPreferencesPath();
    const { blocker, start } = createBlocker();
    const firstController = new DesktopKeepAwakeController({
      preferencesPath,
      blocker,
      onChange: vi.fn(),
    });
    firstController.load();
    firstController.setEnabled(true);
    firstController.release();

    const secondController = new DesktopKeepAwakeController({
      preferencesPath,
      blocker,
      onChange: vi.fn(),
    });

    try {
      expect(secondController.load()).toStrictEqual({
        enabled: true,
        active: true,
      });
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases the blocker without clearing the saved preference", async () => {
    const { directory, preferencesPath } = await createPreferencesPath();
    const { blocker, stop } = createBlocker();
    const controller = new DesktopKeepAwakeController({
      preferencesPath,
      blocker,
      onChange: vi.fn(),
    });
    controller.load();
    controller.setEnabled(true);

    try {
      expect(controller.release()).toStrictEqual({
        enabled: true,
        active: false,
      });
      expect(stop).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(preferencesPath, "utf8"))).toMatchObject(
        {
          keepAwakeEnabled: true,
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
