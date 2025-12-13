import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setCommand } from "../secret/set";
import { listCommand } from "../secret/list";
import { deleteCommand } from "../secret/delete";
import * as secretsClient from "../../lib/secrets-client";

// Mock the secrets client
vi.mock("../../lib/secrets-client");

describe("secret commands", () => {
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

  describe("secret set", () => {
    it("should create a new secret successfully", async () => {
      vi.mocked(secretsClient.createSecret).mockResolvedValue({
        status: 201,
        body: { name: "MY_SECRET", action: "created" as const },
        headers: new Headers(),
      });

      await setCommand.parseAsync(["node", "cli", "MY_SECRET", "my-value"]);

      expect(secretsClient.createSecret).toHaveBeenCalledWith(
        "MY_SECRET",
        "my-value",
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Secret created: MY_SECRET"),
      );
    });

    it("should update an existing secret", async () => {
      vi.mocked(secretsClient.createSecret).mockResolvedValue({
        status: 200,
        body: { name: "MY_SECRET", action: "updated" as const },
        headers: new Headers(),
      });

      await setCommand.parseAsync(["node", "cli", "MY_SECRET", "new-value"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Secret updated: MY_SECRET"),
      );
    });

    it("should reject invalid secret names starting with number", async () => {
      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "123_INVALID", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid secret name"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should reject invalid secret names with hyphens", async () => {
      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "has-hyphens", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Invalid secret name"),
      );
    });

    it("should reject secret names longer than 255 characters", async () => {
      const longName = "A".repeat(256);

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", longName, "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("too long"),
      );
    });

    it("should handle API errors gracefully", async () => {
      vi.mocked(secretsClient.createSecret).mockResolvedValue({
        status: 400,
        body: {
          error: {
            message: "Secret value must be 48 KB or less",
            code: "BAD_REQUEST",
          },
        },
        headers: new Headers(),
      });

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "MY_SECRET", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to set secret"),
      );
    });

    it("should handle network errors", async () => {
      vi.mocked(secretsClient.createSecret).mockRejectedValue(
        new Error("Network error"),
      );

      await expect(async () => {
        await setCommand.parseAsync(["node", "cli", "MY_SECRET", "value"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to set secret"),
      );
    });
  });

  describe("secret list", () => {
    it("should list all secrets", async () => {
      vi.mocked(secretsClient.listSecrets).mockResolvedValue({
        status: 200,
        body: {
          secrets: [
            {
              name: "SECRET_1",
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-02T00:00:00Z",
            },
            {
              name: "SECRET_2",
              createdAt: "2025-01-01T00:00:00Z",
              updatedAt: "2025-01-03T00:00:00Z",
            },
          ],
        },
        headers: new Headers(),
      });

      await listCommand.parseAsync(["node", "cli"]);

      expect(secretsClient.listSecrets).toHaveBeenCalled();
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Secrets:"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("SECRET_1"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("SECRET_2"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Total: 2 secret(s)"),
      );
    });

    it("should show message when no secrets exist", async () => {
      vi.mocked(secretsClient.listSecrets).mockResolvedValue({
        status: 200,
        body: { secrets: [] },
        headers: new Headers(),
      });

      await listCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("No secrets found"),
      );
    });

    it("should handle API errors gracefully", async () => {
      vi.mocked(secretsClient.listSecrets).mockResolvedValue({
        status: 401,
        body: { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
        headers: new Headers(),
      });

      await expect(async () => {
        await listCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list secrets"),
      );
    });
  });

  describe("secret delete", () => {
    it("should delete an existing secret", async () => {
      vi.mocked(secretsClient.deleteSecret).mockResolvedValue({
        status: 200,
        body: { name: "MY_SECRET", deleted: true as const },
        headers: new Headers(),
      });

      await deleteCommand.parseAsync(["node", "cli", "MY_SECRET"]);

      expect(secretsClient.deleteSecret).toHaveBeenCalledWith("MY_SECRET");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Secret deleted: MY_SECRET"),
      );
    });

    it("should URL-encode secret names with special characters", async () => {
      vi.mocked(secretsClient.deleteSecret).mockResolvedValue({
        status: 200,
        body: { name: "SECRET_WITH_UNDERSCORE", deleted: true as const },
        headers: new Headers(),
      });

      await deleteCommand.parseAsync(["node", "cli", "SECRET_WITH_UNDERSCORE"]);

      expect(secretsClient.deleteSecret).toHaveBeenCalledWith(
        "SECRET_WITH_UNDERSCORE",
      );
    });

    it("should handle not found error", async () => {
      vi.mocked(secretsClient.deleteSecret).mockResolvedValue({
        status: 404,
        body: {
          error: {
            message: "Secret not found: NONEXISTENT",
            code: "NOT_FOUND",
          },
        },
        headers: new Headers(),
      });

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "NONEXISTENT"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete secret"),
      );
    });

    it("should handle API errors gracefully", async () => {
      vi.mocked(secretsClient.deleteSecret).mockResolvedValue({
        status: 401,
        body: { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
        headers: new Headers(),
      });

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "MY_SECRET"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete secret"),
      );
    });

    it("should handle network errors", async () => {
      vi.mocked(secretsClient.deleteSecret).mockRejectedValue(
        new Error("Network error"),
      );

      await expect(async () => {
        await deleteCommand.parseAsync(["node", "cli", "MY_SECRET"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to delete secret"),
      );
    });
  });
});
