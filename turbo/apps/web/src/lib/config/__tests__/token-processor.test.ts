/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { processGitHubTokens } from "../token-processor";
import { isEncryptedToken } from "../../crypto/token-encryption";

describe("processGitHubTokens", () => {
  const testUserId = "user-123";
  const testSecret = "test-secret-key-32-chars-long!!";

  it("should encrypt plaintext GitHub personal access token", () => {
    const config = {
      volumes: {
        "my-repo": {
          driver: "git",
          driver_opts: {
            token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    const processedToken = (result as any).volumes["my-repo"].driver_opts.token;
    expect(isEncryptedToken(processedToken)).toBe(true);
    expect(processedToken).toMatch(/^encrypted:AES256:/);
  });

  it("should encrypt fine-grained GitHub PAT", () => {
    const config = {
      volumes: {
        "my-repo": {
          driver: "git",
          driver_opts: {
            token: "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    const processedToken = (result as any).volumes["my-repo"].driver_opts.token;
    expect(isEncryptedToken(processedToken)).toBe(true);
  });

  it("should not re-encrypt already encrypted tokens", () => {
    const encryptedToken = "encrypted:AES256:test:test:test";
    const config = {
      volumes: {
        "my-repo": {
          driver: "git",
          driver_opts: {
            token: encryptedToken,
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    const processedToken = (result as any).volumes["my-repo"].driver_opts.token;
    expect(processedToken).toBe(encryptedToken);
  });

  it("should handle multiple tokens in different volumes", () => {
    const config = {
      volumes: {
        "repo-1": {
          driver: "git",
          driver_opts: {
            token: "ghp_token1",
          },
        },
        "repo-2": {
          driver: "git",
          driver_opts: {
            token: "github_pat_token2",
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    const token1 = (result as any).volumes["repo-1"].driver_opts.token;
    const token2 = (result as any).volumes["repo-2"].driver_opts.token;

    expect(isEncryptedToken(token1)).toBe(true);
    expect(isEncryptedToken(token2)).toBe(true);
  });

  it("should handle mixed static and dynamic volumes", () => {
    const config = {
      volumes: {
        static: {
          driver: "git",
          driver_opts: {
            token: "ghp_static_token",
          },
        },
      },
      dynamic_volumes: {
        dynamic: {
          driver: "git",
          driver_opts: {
            token: "ghp_dynamic_token",
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    const staticToken = (result as any).volumes.static.driver_opts.token;
    const dynamicToken = (result as any).dynamic_volumes.dynamic.driver_opts
      .token;

    expect(isEncryptedToken(staticToken)).toBe(true);
    expect(isEncryptedToken(dynamicToken)).toBe(true);
  });

  it("should not modify non-token strings", () => {
    const config = {
      agent: {
        name: "test-agent",
        description: "This is a test",
      },
      volumes: {
        "my-repo": {
          driver: "git",
          driver_opts: {
            repo: "owner/repo",
            branch: "main",
            token: "ghp_token",
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    expect((result as any).agent.name).toBe("test-agent");
    expect((result as any).agent.description).toBe("This is a test");
    expect((result as any).volumes["my-repo"].driver_opts.repo).toBe(
      "owner/repo",
    );
    expect((result as any).volumes["my-repo"].driver_opts.branch).toBe("main");
    expect(
      isEncryptedToken((result as any).volumes["my-repo"].driver_opts.token),
    ).toBe(true);
  });

  it("should handle S3 volumes without tokens", () => {
    const config = {
      volumes: {
        "s3-volume": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://bucket/path",
            region: "us-west-2",
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    expect(result).toEqual(config);
  });

  it("should handle all GitHub token prefixes", () => {
    const prefixes = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"];

    for (const prefix of prefixes) {
      const config = {
        token: `${prefix}test123`,
      };

      const result = processGitHubTokens(config, testUserId, testSecret);

      expect(isEncryptedToken((result as any).token)).toBe(true);
    }
  });

  it("should preserve non-GitHub token strings", () => {
    const config = {
      token1: "not-a-token",
      token2: "some_other_format",
      token3: "gitlab_token",
      token4: "",
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    expect(result).toEqual(config);
  });

  it("should handle nested objects", () => {
    const config = {
      level1: {
        level2: {
          level3: {
            token: "ghp_nested",
          },
        },
      },
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    expect(isEncryptedToken((result as any).level1.level2.level3.token)).toBe(
      true,
    );
  });

  it("should handle arrays", () => {
    const config = {
      tokens: ["ghp_token1", "not-a-token", "ghp_token2"],
    };

    const result = processGitHubTokens(config, testUserId, testSecret);

    expect(isEncryptedToken((result as any).tokens[0])).toBe(true);
    expect((result as any).tokens[1]).toBe("not-a-token");
    expect(isEncryptedToken((result as any).tokens[2])).toBe(true);
  });
});
