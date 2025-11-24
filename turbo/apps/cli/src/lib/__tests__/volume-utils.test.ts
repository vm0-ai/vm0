import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  isValidVolumeName,
  suggestVolumeName,
  readVolumeConfig,
  writeVolumeConfig,
} from "../volume-utils";

describe("volume-utils", () => {
  describe("isValidVolumeName", () => {
    it("should accept valid volume names", () => {
      expect(isValidVolumeName("mnist")).toBe(true);
      expect(isValidVolumeName("my-dataset")).toBe(true);
      expect(isValidVolumeName("training-data-v2")).toBe(true);
      expect(isValidVolumeName("abc")).toBe(true); // minimum length
      expect(isValidVolumeName("a".repeat(64))).toBe(true); // maximum length
    });

    it("should reject names that are too short", () => {
      expect(isValidVolumeName("ab")).toBe(false);
      expect(isValidVolumeName("a")).toBe(false);
      expect(isValidVolumeName("")).toBe(false);
    });

    it("should reject names that are too long", () => {
      expect(isValidVolumeName("a".repeat(65))).toBe(false);
      expect(isValidVolumeName("a".repeat(100))).toBe(false);
    });

    it("should reject names with uppercase letters", () => {
      expect(isValidVolumeName("MNIST")).toBe(false);
      expect(isValidVolumeName("MyDataset")).toBe(false);
      expect(isValidVolumeName("data-Set")).toBe(false);
    });

    it("should reject names with underscores", () => {
      expect(isValidVolumeName("my_dataset")).toBe(false);
      expect(isValidVolumeName("training_data")).toBe(false);
    });

    it("should reject names starting with hyphen", () => {
      expect(isValidVolumeName("-dataset")).toBe(false);
      expect(isValidVolumeName("-my-data")).toBe(false);
    });

    it("should reject names ending with hyphen", () => {
      expect(isValidVolumeName("dataset-")).toBe(false);
      expect(isValidVolumeName("my-data-")).toBe(false);
    });

    it("should reject names with consecutive hyphens", () => {
      expect(isValidVolumeName("my--data")).toBe(false);
      expect(isValidVolumeName("data--set--v2")).toBe(false);
    });

    it("should reject names with special characters", () => {
      expect(isValidVolumeName("my@dataset")).toBe(false);
      expect(isValidVolumeName("data.set")).toBe(false);
      expect(isValidVolumeName("my/dataset")).toBe(false);
    });
  });

  describe("suggestVolumeName", () => {
    it("should convert valid directory names", () => {
      expect(suggestVolumeName("mnist")).toBe("mnist");
      expect(suggestVolumeName("my-dataset")).toBe("my-dataset");
      expect(suggestVolumeName("training-data")).toBe("training-data");
    });

    it("should convert uppercase to lowercase", () => {
      expect(suggestVolumeName("MNIST")).toBe("mnist");
      expect(suggestVolumeName("MyDataset")).toBe("mydataset");
      expect(suggestVolumeName("Training-Data")).toBe("training-data");
    });

    it("should replace underscores with hyphens", () => {
      expect(suggestVolumeName("my_dataset")).toBe("my-dataset");
      expect(suggestVolumeName("training_data_v2")).toBe("training-data-v2");
    });

    it("should replace spaces with hyphens", () => {
      expect(suggestVolumeName("my dataset")).toBe("my-dataset");
      expect(suggestVolumeName("training data v2")).toBe("training-data-v2");
    });

    it("should replace special characters with hyphens", () => {
      expect(suggestVolumeName("my@dataset")).toBe("my-dataset");
      expect(suggestVolumeName("data.set")).toBe("data-set");
      expect(suggestVolumeName("my/dataset")).toBe("my-dataset");
    });

    it("should remove consecutive hyphens", () => {
      expect(suggestVolumeName("my--dataset")).toBe("my-dataset");
      expect(suggestVolumeName("data___set")).toBe("data-set");
      expect(suggestVolumeName("my  dataset")).toBe("my-dataset");
    });

    it("should remove leading and trailing hyphens", () => {
      expect(suggestVolumeName("-dataset")).toBe("dataset");
      expect(suggestVolumeName("dataset-")).toBe("dataset");
      expect(suggestVolumeName("-my-data-")).toBe("my-data");
    });

    it("should truncate names longer than 64 characters", () => {
      const longName = "a".repeat(100);
      const suggested = suggestVolumeName(longName);
      expect(suggested.length).toBeLessThanOrEqual(64);
    });

    it("should return 'volume' for names shorter than 3 characters after processing", () => {
      expect(suggestVolumeName("ab")).toBe("volume");
      expect(suggestVolumeName("a")).toBe("volume");
      expect(suggestVolumeName("--")).toBe("volume");
    });
  });

  describe("readVolumeConfig and writeVolumeConfig", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "volume-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should write and read volume config", async () => {
      await writeVolumeConfig("mnist", tempDir);

      const config = await readVolumeConfig(tempDir);
      expect(config).toEqual({ name: "mnist" });
    });

    it("should return null when config does not exist", async () => {
      const config = await readVolumeConfig(tempDir);
      expect(config).toBeNull();
    });

    it("should create .vm0 directory if it does not exist", async () => {
      await writeVolumeConfig("test-volume", tempDir);

      const configDir = path.join(tempDir, ".vm0");
      expect(fs.existsSync(configDir)).toBe(true);
    });

    it("should overwrite existing config", async () => {
      await writeVolumeConfig("volume1", tempDir);
      await writeVolumeConfig("volume2", tempDir);

      const config = await readVolumeConfig(tempDir);
      expect(config).toEqual({ name: "volume2" });
    });

    it("should write valid YAML format", async () => {
      await writeVolumeConfig("test-volume", tempDir);

      const configPath = path.join(tempDir, ".vm0", "volume.yaml");
      const content = fs.readFileSync(configPath, "utf8");

      expect(content).toContain("name: test-volume");
    });
  });
});
