import { describe, it, expect } from "vitest";
import { createScriptsTarBuffer, getFirstAgent } from "../docker-executor";
import type { AgentComposeYaml } from "../../../../types/agent-compose";

const BLOCK_SIZE = 512;

describe("getFirstAgent", () => {
  it("returns undefined when compose is undefined", () => {
    expect(getFirstAgent(undefined)).toBeUndefined();
  });

  it("returns undefined when agents section is missing", () => {
    expect(getFirstAgent({ version: "1" } as AgentComposeYaml)).toBeUndefined();
  });

  it("returns undefined when agents is empty", () => {
    const compose: AgentComposeYaml = { version: "1", agents: {} };
    expect(getFirstAgent(compose)).toBeUndefined();
  });

  it("returns the first agent entry", () => {
    const compose: AgentComposeYaml = {
      version: "1",
      agents: {
        "my-agent": {
          image: "custom-image:v1",
          framework: "claude-code",
        },
      },
    };
    const result = getFirstAgent(compose);
    expect(result).toEqual({
      image: "custom-image:v1",
      framework: "claude-code",
    });
  });
});

describe("createScriptsTarBuffer", () => {
  it("produces a valid tar buffer with correct end-of-archive marker", () => {
    const scripts = [
      { content: "#!/bin/bash\necho hello", path: "/usr/local/bin/test.sh" },
    ];
    const tar = createScriptsTarBuffer(scripts);

    // Tar must be aligned to 512-byte blocks
    expect(tar.length % BLOCK_SIZE).toBe(0);

    // Must end with two zero blocks (end-of-archive marker)
    const lastTwoBlocks = tar.subarray(tar.length - BLOCK_SIZE * 2);
    expect(lastTwoBlocks.every((b) => b === 0)).toBe(true);
  });

  it("strips leading slash from file paths in header", () => {
    const scripts = [{ content: "content", path: "/usr/local/bin/agent.mjs" }];
    const tar = createScriptsTarBuffer(scripts);

    // Read the filename from the first 100 bytes of the header
    const nameField = tar
      .subarray(0, 100)
      .toString("utf-8")
      .replaceAll("\0", "");
    expect(nameField).toBe("usr/local/bin/agent.mjs");
  });

  it("preserves path without leading slash", () => {
    const scripts = [{ content: "data", path: "relative/path.sh" }];
    const tar = createScriptsTarBuffer(scripts);

    const nameField = tar
      .subarray(0, 100)
      .toString("utf-8")
      .replaceAll("\0", "");
    expect(nameField).toBe("relative/path.sh");
  });

  it("sets correct file size in header", () => {
    const fileContent = "hello world!";
    const scripts = [{ content: fileContent, path: "test.txt" }];
    const tar = createScriptsTarBuffer(scripts);

    // Size field is at offset 124, 12 bytes, octal null-terminated
    const sizeField = tar
      .subarray(124, 136)
      .toString("utf-8")
      .replaceAll("\0", "");
    const sizeValue = parseInt(sizeField, 8);
    expect(sizeValue).toBe(Buffer.from(fileContent, "utf-8").length);
  });

  it("sets executable permissions (0755)", () => {
    const scripts = [{ content: "#!/bin/sh", path: "run.sh" }];
    const tar = createScriptsTarBuffer(scripts);

    // Mode field is at offset 100, 8 bytes
    const modeField = tar
      .subarray(100, 108)
      .toString("utf-8")
      .replaceAll("\0", "");
    expect(modeField).toBe("0000755");
  });

  it("writes ustar format magic", () => {
    const scripts = [{ content: "x", path: "f.txt" }];
    const tar = createScriptsTarBuffer(scripts);

    // Magic field at offset 257, 6 bytes
    const magic = tar.subarray(257, 263).toString("utf-8");
    expect(magic).toBe("ustar\0");
  });

  it("produces valid checksum", () => {
    const scripts = [
      { content: "test content for checksum validation", path: "check.mjs" },
    ];
    const tar = createScriptsTarBuffer(scripts);
    const header = tar.subarray(0, BLOCK_SIZE);

    // Read written checksum from offset 148, 8 bytes
    const checksumField = header
      .subarray(148, 156)
      .toString("utf-8")
      .replaceAll("\0", "")
      .trim();
    const writtenChecksum = parseInt(checksumField, 8);

    // Compute expected checksum: treat checksum field (148..155) as spaces
    let expected = 0;
    for (let i = 0; i < BLOCK_SIZE; i++) {
      if (i >= 148 && i < 156) {
        expected += 0x20; // space
      } else {
        expected += header.readUInt8(i);
      }
    }
    expect(writtenChecksum).toBe(expected);
  });

  it("pads file content to 512-byte boundary", () => {
    const content = "short";
    const contentLen = Buffer.from(content, "utf-8").length;
    const scripts = [{ content, path: "pad.txt" }];
    const tar = createScriptsTarBuffer(scripts);

    // After header (512) and content, padding should fill to next 512 boundary
    const expectedPadding = BLOCK_SIZE - (contentLen % BLOCK_SIZE);
    const paddingStart = BLOCK_SIZE + contentLen;
    const paddingEnd =
      paddingStart + (expectedPadding < BLOCK_SIZE ? expectedPadding : 0);

    if (expectedPadding < BLOCK_SIZE) {
      const padding = tar.subarray(paddingStart, paddingEnd);
      expect(padding.every((b) => b === 0)).toBe(true);
    }
  });

  it("handles multiple scripts in sequence", () => {
    const scripts = [
      { content: "script one", path: "/bin/one.mjs" },
      { content: "script two with more content", path: "/bin/two.mjs" },
      { content: "three", path: "bin/three.mjs" },
    ];
    const tar = createScriptsTarBuffer(scripts);

    // Should have 3 headers + 3 content blocks (with padding) + 2 zero blocks
    expect(tar.length % BLOCK_SIZE).toBe(0);

    // Verify each script header name
    let offset = 0;
    for (const script of scripts) {
      const expectedName = script.path.startsWith("/")
        ? script.path.slice(1)
        : script.path;
      const name = tar
        .subarray(offset, offset + 100)
        .toString("utf-8")
        .replaceAll("\0", "");
      expect(name).toBe(expectedName);

      // Advance past header + content + padding
      const contentSize = Buffer.from(script.content, "utf-8").length;
      const padding = BLOCK_SIZE - (contentSize % BLOCK_SIZE);
      offset += BLOCK_SIZE + contentSize + (padding < BLOCK_SIZE ? padding : 0);
    }
  });

  it("writes correct file content after header", () => {
    const content = "#!/usr/bin/env node\nconsole.log('hello');";
    const scripts = [{ content, path: "agent.mjs" }];
    const tar = createScriptsTarBuffer(scripts);

    const contentBuffer = Buffer.from(content, "utf-8");
    const written = tar.subarray(BLOCK_SIZE, BLOCK_SIZE + contentBuffer.length);
    expect(written.toString("utf-8")).toBe(content);
  });

  it("handles empty scripts array with only end-of-archive marker", () => {
    const tar = createScriptsTarBuffer([]);
    expect(tar.length).toBe(BLOCK_SIZE * 2);
    expect(tar.every((b) => b === 0)).toBe(true);
  });
});
