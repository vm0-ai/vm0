import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  isValidStorageName,
  readStorageConfig,
  writeStorageConfig,
} from "../storage-utils";

describe("storage-utils", () => {
  describe("isValidStorageName", () => {
    it("should accept valid storage names", () => {
      expect(isValidStorageName("mnist")).toBe(true);
      expect(isValidStorageName("my-dataset")).toBe(true);
      expect(isValidStorageName("training-data-v2")).toBe(true);
      expect(isValidStorageName("abc")).toBe(true); // minimum length
      expect(isValidStorageName("a".repeat(64))).toBe(true); // maximum length
    });

    it("should reject names that are too short", () => {
      expect(isValidStorageName("ab")).toBe(false);
      expect(isValidStorageName("a")).toBe(false);
      expect(isValidStorageName("")).toBe(false);
    });

    it("should reject names that are too long", () => {
      expect(isValidStorageName("a".repeat(65))).toBe(false);
      expect(isValidStorageName("a".repeat(100))).toBe(false);
    });

    it("should reject names with uppercase letters", () => {
      expect(isValidStorageName("MNIST")).toBe(false);
      expect(isValidStorageName("MyDataset")).toBe(false);
      expect(isValidStorageName("data-Set")).toBe(false);
    });

    it("should reject names with underscores", () => {
      expect(isValidStorageName("my_dataset")).toBe(false);
      expect(isValidStorageName("training_data")).toBe(false);
    });

    it("should reject names starting with hyphen", () => {
      expect(isValidStorageName("-dataset")).toBe(false);
      expect(isValidStorageName("-my-data")).toBe(false);
    });

    it("should reject names ending with hyphen", () => {
      expect(isValidStorageName("dataset-")).toBe(false);
      expect(isValidStorageName("my-data-")).toBe(false);
    });

    it("should reject names with consecutive hyphens", () => {
      expect(isValidStorageName("my--data")).toBe(false);
      expect(isValidStorageName("data--set--v2")).toBe(false);
    });

    it("should reject names with special characters", () => {
      expect(isValidStorageName("my@dataset")).toBe(false);
      expect(isValidStorageName("data.set")).toBe(false);
      expect(isValidStorageName("my/dataset")).toBe(false);
    });
  });

  describe("readStorageConfig and writeStorageConfig", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should write and read volume config", async () => {
      await writeStorageConfig("mnist", tempDir, "volume");

      const config = await readStorageConfig(tempDir);
      expect(config).toEqual({ name: "mnist", type: "volume" });
    });

    it("should write and read artifact config", async () => {
      await writeStorageConfig("my-artifact", tempDir, "artifact");

      const config = await readStorageConfig(tempDir);
      expect(config).toEqual({ name: "my-artifact", type: "artifact" });
    });

    it("should return null when config does not exist", async () => {
      const config = await readStorageConfig(tempDir);
      expect(config).toBeNull();
    });

    it("should create .vm0 directory if it does not exist", async () => {
      await writeStorageConfig("test-storage", tempDir);

      const configDir = path.join(tempDir, ".vm0");
      expect(fs.existsSync(configDir)).toBe(true);
    });

    it("should overwrite existing config", async () => {
      await writeStorageConfig("storage1", tempDir);
      await writeStorageConfig("storage2", tempDir);

      const config = await readStorageConfig(tempDir);
      expect(config).toEqual({ name: "storage2", type: "volume" });
    });

    it("should write valid YAML format", async () => {
      await writeStorageConfig("test-storage", tempDir);

      const configPath = path.join(tempDir, ".vm0", "storage.yaml");
      const content = fs.readFileSync(configPath, "utf8");

      expect(content).toContain("name: test-storage");
      expect(content).toContain("type: volume");
    });

    it("should default to volume type when not specified", async () => {
      await writeStorageConfig("test-storage", tempDir);

      const config = await readStorageConfig(tempDir);
      expect(config?.type).toBe("volume");
    });

    it("should read legacy volume.yaml config", async () => {
      // Create legacy config manually
      const configDir = path.join(tempDir, ".vm0");
      fs.mkdirSync(configDir, { recursive: true });
      const legacyPath = path.join(configDir, "volume.yaml");
      fs.writeFileSync(legacyPath, "name: legacy-volume\ntype: volume\n");

      const config = await readStorageConfig(tempDir);
      expect(config).toEqual({ name: "legacy-volume", type: "volume" });
    });

    it("should prefer storage.yaml over legacy volume.yaml", async () => {
      // Create both files
      const configDir = path.join(tempDir, ".vm0");
      fs.mkdirSync(configDir, { recursive: true });

      const legacyPath = path.join(configDir, "volume.yaml");
      fs.writeFileSync(legacyPath, "name: legacy-volume\ntype: volume\n");

      const newPath = path.join(configDir, "storage.yaml");
      fs.writeFileSync(newPath, "name: new-storage\ntype: artifact\n");

      const config = await readStorageConfig(tempDir);
      expect(config).toEqual({ name: "new-storage", type: "artifact" });
    });
  });
});
