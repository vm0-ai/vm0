import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { uploadGitHubDirectory } from "../github-client";
import { execSync } from "child_process";
import fs from "fs/promises";

// Mock child_process and fs
vi.mock("child_process");
vi.mock("fs/promises");

describe("uploadGitHubDirectory", () => {
  const mockLocalPath = "/tmp/test-workspace";
  const mockGithubUri = "github://owner/repo@main";
  const mockBranch = "run-test-123";
  const mockCommitMessage = "Test commit";
  const mockToken = "ghp_test123";
  const mockUserId = "user-123";
  const mockSecret = "test-secret-32-chars-long!!!!!";
  const mockCommitSha = "abc123def456";

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock fs operations
    vi.mocked(fs.readdir).mockResolvedValue([
      { name: "file.txt", isDirectory: () => false } as never,
    ]);
    vi.mocked(fs.stat).mockResolvedValue({ size: 100 } as never);

    // Mock execSync to return commit SHA with proper encoding
    vi.mocked(execSync).mockImplementation(
      (cmd: string, options?: { encoding?: string }) => {
        if (cmd.includes("git rev-parse HEAD")) {
          if (options?.encoding === "utf8") {
            return mockCommitSha as never;
          }
          return Buffer.from(mockCommitSha);
        }
        return Buffer.from("");
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should initialize git repository", async () => {
    await uploadGitHubDirectory(
      mockLocalPath,
      mockGithubUri,
      mockBranch,
      mockCommitMessage,
      mockToken,
      mockUserId,
      mockSecret,
    );

    expect(execSync).toHaveBeenCalledWith("git init", expect.any(Object));
  });

  it("should configure git user", async () => {
    await uploadGitHubDirectory(
      mockLocalPath,
      mockGithubUri,
      mockBranch,
      mockCommitMessage,
      mockToken,
      mockUserId,
      mockSecret,
    );

    expect(execSync).toHaveBeenCalledWith(
      'git config user.name "VM0 Agent"',
      expect.any(Object),
    );
    expect(execSync).toHaveBeenCalledWith(
      'git config user.email "agent@vm0.ai"',
      expect.any(Object),
    );
  });

  it("should create branch from main", async () => {
    await uploadGitHubDirectory(
      mockLocalPath,
      mockGithubUri,
      mockBranch,
      mockCommitMessage,
      mockToken,
      mockUserId,
      mockSecret,
    );

    expect(execSync).toHaveBeenCalledWith(
      "git fetch origin main",
      expect.any(Object),
    );
    expect(execSync).toHaveBeenCalledWith(
      `git checkout -b ${mockBranch} origin/main`,
      expect.any(Object),
    );
  });

  it("should commit and push changes", async () => {
    await uploadGitHubDirectory(
      mockLocalPath,
      mockGithubUri,
      mockBranch,
      mockCommitMessage,
      mockToken,
      mockUserId,
      mockSecret,
    );

    expect(execSync).toHaveBeenCalledWith(
      "git add .",
      expect.objectContaining({ cwd: mockLocalPath }),
    );
    expect(execSync).toHaveBeenCalledWith(
      `git commit -m "${mockCommitMessage}"`,
      expect.any(Object),
    );
    expect(execSync).toHaveBeenCalledWith(
      `git push origin ${mockBranch}`,
      expect.any(Object),
    );
  });

  it("should return commit SHA and metadata", async () => {
    const result = await uploadGitHubDirectory(
      mockLocalPath,
      mockGithubUri,
      mockBranch,
      mockCommitMessage,
      mockToken,
      mockUserId,
      mockSecret,
    );

    expect(result).toEqual({
      commitSha: mockCommitSha,
      branch: mockBranch,
      filesUploaded: 1,
    });
  });

  it("should handle plaintext tokens", async () => {
    // Use plaintext token instead of testing encrypted one
    await uploadGitHubDirectory(
      mockLocalPath,
      mockGithubUri,
      mockBranch,
      mockCommitMessage,
      mockToken,
      mockUserId,
      mockSecret,
    );

    // Should have added remote with token in URL
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining("git remote add origin"),
      expect.any(Object),
    );
  });

  it("should throw error on git failure", async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("Git command failed");
    });

    await expect(
      uploadGitHubDirectory(
        mockLocalPath,
        mockGithubUri,
        mockBranch,
        mockCommitMessage,
        mockToken,
        mockUserId,
        mockSecret,
      ),
    ).rejects.toThrow("Failed to upload to GitHub repository");
  });
});
