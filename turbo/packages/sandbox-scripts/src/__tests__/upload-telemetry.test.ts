import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readFileFromPosition,
  savePosition,
  readJsonlFromPosition,
} from "../scripts/lib/upload-telemetry";

describe("upload-telemetry", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-telemetry-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("readFileFromPosition", () => {
    it("should read entire file when position file does not exist", () => {
      const filePath = path.join(tempDir, "data.txt");
      const posFile = path.join(tempDir, "pos.txt");
      const content = "Hello, World!";
      fs.writeFileSync(filePath, content);

      const [readContent, newPos] = readFileFromPosition(filePath, posFile);

      expect(readContent).toBe(content);
      expect(newPos).toBe(content.length);
    });

    it("should read from last position when position file exists", () => {
      const filePath = path.join(tempDir, "data.txt");
      const posFile = path.join(tempDir, "pos.txt");
      const content = "Hello, World!";
      fs.writeFileSync(filePath, content);
      fs.writeFileSync(posFile, "7"); // Position after "Hello, "

      const [readContent, newPos] = readFileFromPosition(filePath, posFile);

      expect(readContent).toBe("World!");
      expect(newPos).toBe(content.length);
    });

    it("should return empty string when no new content", () => {
      const filePath = path.join(tempDir, "data.txt");
      const posFile = path.join(tempDir, "pos.txt");
      const content = "Hello";
      fs.writeFileSync(filePath, content);
      fs.writeFileSync(posFile, String(content.length));

      const [readContent, newPos] = readFileFromPosition(filePath, posFile);

      expect(readContent).toBe("");
      expect(newPos).toBe(content.length);
    });

    it("should return empty when file does not exist", () => {
      const filePath = path.join(tempDir, "nonexistent.txt");
      const posFile = path.join(tempDir, "pos.txt");

      const [readContent, newPos] = readFileFromPosition(filePath, posFile);

      expect(readContent).toBe("");
      expect(newPos).toBe(0);
    });

    it("should handle invalid position file content", () => {
      const filePath = path.join(tempDir, "data.txt");
      const posFile = path.join(tempDir, "pos.txt");
      const content = "Hello";
      fs.writeFileSync(filePath, content);
      fs.writeFileSync(posFile, "invalid");

      const [readContent, newPos] = readFileFromPosition(filePath, posFile);

      expect(readContent).toBe(content);
      expect(newPos).toBe(content.length);
    });

    it("should handle appended content", () => {
      const filePath = path.join(tempDir, "data.txt");
      const posFile = path.join(tempDir, "pos.txt");

      // Initial content
      fs.writeFileSync(filePath, "Initial");
      const [content1, pos1] = readFileFromPosition(filePath, posFile);
      expect(content1).toBe("Initial");

      // Save position
      savePosition(posFile, pos1);

      // Append content
      fs.appendFileSync(filePath, " Appended");
      const [content2, pos2] = readFileFromPosition(filePath, posFile);
      expect(content2).toBe(" Appended");
      expect(pos2).toBe("Initial Appended".length);
    });
  });

  describe("savePosition", () => {
    it("should write position to file", () => {
      const posFile = path.join(tempDir, "pos.txt");

      savePosition(posFile, 12345);

      expect(fs.readFileSync(posFile, "utf-8")).toBe("12345");
    });

    it("should overwrite existing position", () => {
      const posFile = path.join(tempDir, "pos.txt");
      fs.writeFileSync(posFile, "100");

      savePosition(posFile, 200);

      expect(fs.readFileSync(posFile, "utf-8")).toBe("200");
    });

    it("should handle zero position", () => {
      const posFile = path.join(tempDir, "pos.txt");

      savePosition(posFile, 0);

      expect(fs.readFileSync(posFile, "utf-8")).toBe("0");
    });
  });

  describe("readJsonlFromPosition", () => {
    it("should read and parse JSONL entries", () => {
      const filePath = path.join(tempDir, "data.jsonl");
      const posFile = path.join(tempDir, "pos.txt");
      const entries = [
        { type: "event1", value: 1 },
        { type: "event2", value: 2 },
      ];
      fs.writeFileSync(
        filePath,
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      const [result, newPos] = readJsonlFromPosition(filePath, posFile);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: "event1", value: 1 });
      expect(result[1]).toEqual({ type: "event2", value: 2 });
      expect(newPos).toBeGreaterThan(0);
    });

    it("should return empty array when file does not exist", () => {
      const filePath = path.join(tempDir, "nonexistent.jsonl");
      const posFile = path.join(tempDir, "pos.txt");

      const [result, newPos] = readJsonlFromPosition(filePath, posFile);

      expect(result).toEqual([]);
      expect(newPos).toBe(0);
    });

    it("should skip invalid JSON lines", () => {
      const filePath = path.join(tempDir, "data.jsonl");
      const posFile = path.join(tempDir, "pos.txt");
      const content = '{"valid": true}\ninvalid json\n{"also": "valid"}\n';
      fs.writeFileSync(filePath, content);

      const [result] = readJsonlFromPosition(filePath, posFile);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ valid: true });
      expect(result[1]).toEqual({ also: "valid" });
    });

    it("should skip empty lines", () => {
      const filePath = path.join(tempDir, "data.jsonl");
      const posFile = path.join(tempDir, "pos.txt");
      const content = '{"a": 1}\n\n\n{"b": 2}\n';
      fs.writeFileSync(filePath, content);

      const [result] = readJsonlFromPosition(filePath, posFile);

      expect(result).toHaveLength(2);
    });

    it("should read incrementally from position", () => {
      const filePath = path.join(tempDir, "data.jsonl");
      const posFile = path.join(tempDir, "pos.txt");

      // Write initial entries
      fs.writeFileSync(filePath, '{"seq": 1}\n{"seq": 2}\n');

      // Read first batch
      const [batch1, pos1] = readJsonlFromPosition(filePath, posFile);
      expect(batch1).toHaveLength(2);
      savePosition(posFile, pos1);

      // Append more entries
      fs.appendFileSync(filePath, '{"seq": 3}\n{"seq": 4}\n');

      // Read second batch
      const [batch2] = readJsonlFromPosition(filePath, posFile);
      expect(batch2).toHaveLength(2);
      expect(batch2[0]).toEqual({ seq: 3 });
      expect(batch2[1]).toEqual({ seq: 4 });
    });

    it("should return empty array when no new content", () => {
      const filePath = path.join(tempDir, "data.jsonl");
      const posFile = path.join(tempDir, "pos.txt");
      fs.writeFileSync(filePath, '{"a": 1}\n');

      // Read all content
      const [batch1, pos1] = readJsonlFromPosition(filePath, posFile);
      expect(batch1).toHaveLength(1);
      savePosition(posFile, pos1);

      // Read again with no new content
      const [batch2] = readJsonlFromPosition(filePath, posFile);
      expect(batch2).toEqual([]);
    });

    it("should handle complex JSON objects", () => {
      const filePath = path.join(tempDir, "data.jsonl");
      const posFile = path.join(tempDir, "pos.txt");
      const complexEntry = {
        type: "metrics",
        data: {
          cpu: 45.5,
          memory: [1024, 2048],
          labels: { env: "test" },
        },
        timestamp: "2026-01-16T00:00:00Z",
      };
      fs.writeFileSync(filePath, JSON.stringify(complexEntry) + "\n");

      const [result] = readJsonlFromPosition(filePath, posFile);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(complexEntry);
    });
  });
});
