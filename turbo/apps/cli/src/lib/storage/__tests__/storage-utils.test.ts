/**
 * Tests for storage-utils readStorageConfig compatibility shims.
 *
 * Real filesystem (temp dirs), no mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import { readStorageConfig } from "../storage-utils";

describe("readStorageConfig", () => {
  let tempDir: string;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "storage-utils-test-"));
    mkdirSync(path.join(tempDir, ".vm0"));
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      return true;
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    stderrSpy.mockRestore();
  });

  it("normalises legacy type: memory to artifact and warns once per path", async () => {
    const configPath = path.join(tempDir, ".vm0", "storage.yaml");
    writeFileSync(configPath, "name: legacy-mem\ntype: memory\n");

    const first = await readStorageConfig(tempDir);
    expect(first).toEqual({ name: "legacy-mem", type: "artifact" });

    const second = await readStorageConfig(tempDir);
    expect(second).toEqual({ name: "legacy-mem", type: "artifact" });

    const warnCalls = stderrSpy.mock.calls.filter((call: unknown[]) => {
      return String(call[0]).includes('type: "memory"');
    });
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0][0])).toContain(configPath);
    expect(String(warnCalls[0][0])).toContain("deprecated");
  });

  it("returns type: volume unchanged", async () => {
    writeFileSync(
      path.join(tempDir, ".vm0", "storage.yaml"),
      "name: my-volume\ntype: volume\n",
    );

    const config = await readStorageConfig(tempDir);
    expect(config).toEqual({ name: "my-volume", type: "volume" });
  });

  it("defaults missing type to volume", async () => {
    writeFileSync(
      path.join(tempDir, ".vm0", "storage.yaml"),
      "name: untyped\n",
    );

    const config = await readStorageConfig(tempDir);
    expect(config).toEqual({ name: "untyped", type: "volume" });
  });

  it("preserves type: memory when normalizeMemoryToArtifact is false", async () => {
    writeFileSync(
      path.join(tempDir, ".vm0", "storage.yaml"),
      "name: still-memory\ntype: memory\n",
    );

    const config = await readStorageConfig(tempDir, {
      normalizeMemoryToArtifact: false,
    });
    expect(config).toEqual({ name: "still-memory", type: "memory" });

    const warnCalls = stderrSpy.mock.calls.filter((call: unknown[]) => {
      return String(call[0]).includes('type: "memory"');
    });
    expect(warnCalls).toHaveLength(0);
  });
});
