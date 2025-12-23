import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCommand } from "../build";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { apiClient } from "../../../lib/api-client";

// Mock dependencies
vi.mock("fs/promises");
vi.mock("fs");
vi.mock("../../../lib/api-client");

describe("image build command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("file validation", () => {
    it("should exit with error if Dockerfile does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Dockerfile not found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("name validation", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
    });

    it("should exit with error for invalid name format", async () => {
      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "ab", // too short
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid name format"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should exit with error for vm0- prefix", async () => {
      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "vm0-my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0-"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("dockerfile validation", () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(apiClient.getScope).mockResolvedValue({
        id: "scope-123",
        slug: "testorg",
        type: "personal",
        displayName: "Test Org",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
    });

    it("should reject Dockerfile with COPY instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
COPY package.json .
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Dockerfile validation failed"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: COPY"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with ADD instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
ADD https://example.com/file.tar.gz /tmp/
RUN tar -xzf /tmp/file.tar.gz`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: ADD"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with WORKDIR instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
WORKDIR /app
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: WORKDIR"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with USER instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
USER node
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: USER"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with ENV instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
ENV NODE_ENV=production
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: ENV"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with CMD instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
RUN npm install
CMD ["node", "index.js"]`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: CMD"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with ENTRYPOINT instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
RUN npm install
ENTRYPOINT ["node"]`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: ENTRYPOINT"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with EXPOSE instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
EXPOSE 3000
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: EXPOSE"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with VOLUME instruction", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
VOLUME /data
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: VOLUME"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject Dockerfile with multiple unsupported instructions", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
WORKDIR /app
COPY . .
ENV NODE_ENV=production
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: WORKDIR"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: COPY"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported instruction: ENV"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should show helpful message when validation fails", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
COPY package.json .
RUN npm install`);

      await expect(async () => {
        await buildCommand.parseAsync([
          "node",
          "cli",
          "-f",
          "Dockerfile",
          "-n",
          "my-image",
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("only supports FROM and RUN instructions"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("pre-install environment dependencies"),
      );
    });

    it("should accept valid Dockerfile with only FROM and RUN", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM node:24
RUN apt-get update && apt-get install -y git
RUN npm install -g @anthropic-ai/claude-code@latest`);
      vi.mocked(apiClient.createImage).mockResolvedValue({
        imageId: "img-123",
        buildId: "bld-456",
        alias: "my-image",
        versionId: "abc123def456",
      });
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: true,
        json: async () => ({
          status: "ready",
          logs: [],
          logsOffset: 0,
        }),
      } as Response);

      await buildCommand.parseAsync([
        "node",
        "cli",
        "-f",
        "Dockerfile",
        "-n",
        "my-image",
      ]);

      expect(apiClient.createImage).toHaveBeenCalled();
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Image built"),
      );
    });

    it("should accept Dockerfile with comments and empty lines", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`# This is a comment
FROM node:24

# Install dependencies
RUN npm install`);
      vi.mocked(apiClient.createImage).mockResolvedValue({
        imageId: "img-123",
        buildId: "bld-456",
        alias: "my-image",
        versionId: "abc123def456",
      });
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: true,
        json: async () => ({
          status: "ready",
          logs: [],
          logsOffset: 0,
        }),
      } as Response);

      await buildCommand.parseAsync([
        "node",
        "cli",
        "-f",
        "Dockerfile",
        "-n",
        "my-image",
      ]);

      expect(apiClient.createImage).toHaveBeenCalled();
    });

    it("should accept Dockerfile with multi-line RUN", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(`FROM ubuntu:22.04
RUN apt-get update && apt-get install -y \\
    git \\
    curl \\
    python3 \\
    python3-pip \\
    && rm -rf /var/lib/apt/lists/`);
      vi.mocked(apiClient.createImage).mockResolvedValue({
        imageId: "img-123",
        buildId: "bld-456",
        alias: "my-image",
        versionId: "abc123def456",
      });
      vi.mocked(apiClient.get).mockResolvedValue({
        ok: true,
        json: async () => ({
          status: "ready",
          logs: [],
          logsOffset: 0,
        }),
      } as Response);

      await buildCommand.parseAsync([
        "node",
        "cli",
        "-f",
        "Dockerfile",
        "-n",
        "my-image",
      ]);

      expect(apiClient.createImage).toHaveBeenCalled();
    });
  });
});
