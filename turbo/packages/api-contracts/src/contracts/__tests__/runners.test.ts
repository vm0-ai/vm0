import { describe, expect, it } from "vitest";

import {
  elapsedSinceApiStartMs,
  executionContextSchema,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  resumeSessionSchema,
  runnersJobClaimContract,
  storageManifestSchema,
  storedExecutionContextSchema,
  storedResumeSessionSchema,
} from "../runners";

describe("runner storage manifest contract", () => {
  it("accepts the web-produced claim manifest shape", () => {
    expect(
      storageManifestSchema.parse({
        storages: [
          {
            name: "workspace",
            mountPath: "/workspace",
            vasStorageName: "workspace-volume",
            vasVersionId: "version-1",
            archiveUrl: "https://storage.example/archive.tar.gz",
          },
        ],
        artifacts: [
          {
            mountPath: "/home/user/.claude/projects/project",
            vasStorageName: "memory",
            vasStorageId: "storage-id-1",
            vasVersionId: "version-2",
            archiveUrl: "https://storage.example/artifact.tar.gz",
          },
        ],
      }),
    ).toEqual({
      storages: [
        {
          name: "workspace",
          mountPath: "/workspace",
          vasStorageName: "workspace-volume",
          vasVersionId: "version-1",
          archiveUrl: "https://storage.example/archive.tar.gz",
        },
      ],
      artifacts: [
        {
          mountPath: "/home/user/.claude/projects/project",
          vasStorageName: "memory",
          vasStorageId: "storage-id-1",
          vasVersionId: "version-2",
          archiveUrl: "https://storage.example/artifact.tar.gz",
        },
      ],
    });
  });

  it("strips legacy artifact manifest urls", () => {
    expect(
      storageManifestSchema.parse({
        storages: [],
        artifacts: [
          {
            mountPath: "/home/user/.claude/projects/project",
            vasStorageName: "memory",
            vasStorageId: "storage-id-1",
            vasVersionId: "version-2",
            archiveUrl: "https://storage.example/artifact.tar.gz",
            manifestUrl: "https://storage.example/manifest.json",
          },
        ],
      }),
    ).toEqual({
      storages: [],
      artifacts: [
        {
          mountPath: "/home/user/.claude/projects/project",
          vasStorageName: "memory",
          vasStorageId: "storage-id-1",
          vasVersionId: "version-2",
          archiveUrl: "https://storage.example/artifact.tar.gz",
        },
      ],
    });
  });

  it("rejects guest-download-only nullable archive urls", () => {
    const result = storageManifestSchema.safeParse({
      storages: [
        {
          name: "workspace",
          mountPath: "/workspace",
          vasStorageName: "workspace-volume",
          vasVersionId: "version-1",
          archiveUrl: null,
        },
      ],
      artifacts: [],
    });

    expect(result.success).toBe(false);
  });

  it("accepts preserve-parent missing-root policy on artifact entries", () => {
    const manifest = storageManifestSchema.parse({
      storages: [],
      artifacts: [
        {
          mountPath: "/home/user/.claude/projects/-home-user-workspace/memory",
          vasStorageName: "memory",
          vasStorageId: "storage-id-1",
          vasVersionId: "version-2",
          archiveUrl: "https://storage.example/artifact.tar.gz",
          missingRootPolicy: "preserveParentVersion",
        },
      ],
    });

    expect(manifest.artifacts[0]?.missingRootPolicy).toBe(
      "preserveParentVersion",
    );
  });

  it("accepts explicit fail missing-root policy on artifact entries", () => {
    const manifest = storageManifestSchema.parse({
      storages: [],
      artifacts: [
        {
          mountPath: "/home/user/.claude/projects/-home-user-workspace/memory",
          vasStorageName: "memory",
          vasStorageId: "storage-id-1",
          vasVersionId: "version-2",
          archiveUrl: "https://storage.example/artifact.tar.gz",
          missingRootPolicy: "fail",
        },
      ],
    });

    expect(manifest.artifacts[0]?.missingRootPolicy).toBe("fail");
  });

  it("rejects unknown artifact missing-root policies", () => {
    const result = storageManifestSchema.safeParse({
      storages: [],
      artifacts: [
        {
          mountPath: "/home/user/.claude/projects/-home-user-workspace/memory",
          vasStorageName: "memory",
          vasStorageId: "storage-id-1",
          vasVersionId: "version-2",
          archiveUrl: "https://storage.example/artifact.tar.gz",
          missingRootPolicy: "ignore",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("strips runner-derived guest-download fields", () => {
    const manifest = storageManifestSchema.parse({
      storages: [
        {
          name: "workspace",
          mountPath: "/workspace",
          vasStorageName: "workspace-volume",
          vasVersionId: "version-1",
          archiveUrl: "https://storage.example/archive.tar.gz",
          cached: true,
        },
      ],
      artifacts: [],
      cleanupPaths: ["/workspace"],
    });

    expect(manifest).toEqual({
      storages: [
        {
          name: "workspace",
          mountPath: "/workspace",
          vasStorageName: "workspace-volume",
          vasVersionId: "version-1",
          archiveUrl: "https://storage.example/archive.tar.gz",
        },
      ],
      artifacts: [],
    });
  });
});

describe("runner resume session contract", () => {
  const historyHash =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("accepts inline stored and claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      sessionHistory: '{"type":"init"}\n',
    };

    expect(storedResumeSessionSchema.safeParse(resumeSession).success).toBe(
      true,
    );
    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(true);
  });

  it("accepts hash-backed stored resume sessions without URLs", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: historyHash },
    };

    expect(storedResumeSessionSchema.parse(resumeSession)).toEqual(
      resumeSession,
    );
    expect(
      storedExecutionContextSchema.shape.resumeSession.safeParse(resumeSession)
        .success,
    ).toBe(true);
  });

  it("requires a URL for hash-backed claim resume sessions", () => {
    const storedResumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: historyHash },
    };
    const claimResumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        rawSize: 1024,
        encodedSize: 1024,
      },
    };

    expect(resumeSessionSchema.safeParse(storedResumeSession).success).toBe(
      false,
    );
    expect(resumeSessionSchema.parse(claimResumeSession)).toEqual(
      claimResumeSession,
    );
    expect(
      executionContextSchema.shape.resumeSession.safeParse(claimResumeSession)
        .success,
    ).toBe(true);
  });

  it("rejects non-lowercase session history hashes", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: { kind: "blob", hash: "A".repeat(64) },
    };

    expect(storedResumeSessionSchema.safeParse(resumeSession).success).toBe(
      false,
    );
    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("rejects oversized hash-backed claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob?sig=secret",
        rawSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
        encodedSize: RESUME_SESSION_HISTORY_MAX_BYTES + 1,
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });

  it("accepts gzip hash-backed claim resume sessions with explicit sizes", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.gz?sig=secret",
        encoding: "gzip",
        rawSize: 1024,
        encodedSize: 128,
      },
    };

    expect(resumeSessionSchema.parse(resumeSession)).toEqual(resumeSession);
  });

  it("rejects malformed gzip claim resume sessions", () => {
    const resumeSession = {
      sessionId: "sess-123",
      historyRef: {
        kind: "blob",
        hash: historyHash,
        url: "https://r2.example.com/blobs/history.blob.gz?sig=secret",
        encoding: "gzip",
      },
    };

    expect(resumeSessionSchema.safeParse(resumeSession).success).toBe(false);
  });
});

describe("runner claim capability contract", () => {
  it("accepts unknown capabilities for forward compatibility", () => {
    const result = runnersJobClaimContract.claim.body.safeParse({
      capabilities: ["resumeSessionHistoryRef", "futureCapability"],
    });

    expect(result.success).toBe(true);
  });
});

describe("runner firewall entry contract", () => {
  it("accepts compact builtin firewall entries", () => {
    const firewalls = [
      {
        kind: "builtin",
        name: "zendesk",
        baseUrlVars: { ZENDESK_SUBDOMAIN: "acme" },
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
  });

  it("accepts inline firewall entries", () => {
    const firewalls = [
      {
        kind: "inline",
        firewall: {
          name: "internal-api",
          apis: [
            {
              base: "https://api.internal.example.com",
              auth: { headers: { Authorization: "${{ secrets.TOKEN }}" } },
              permissions: [{ name: "read", rules: ["GET /items"] }],
            },
          ],
        },
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(true);
  });

  it("rejects legacy expanded firewall entries in execution contexts", () => {
    const firewalls = [
      {
        name: "github",
        apis: [{ base: "https://api.github.com", auth: { headers: {} } }],
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
  });

  it("rejects unsupported execution firewall kinds", () => {
    const firewalls = [
      {
        kind: "unknown",
        name: "github",
        apis: [{ base: "https://api.github.com", auth: { headers: {} } }],
      },
    ];

    expect(
      storedExecutionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.firewalls.safeParse(firewalls).success,
    ).toBe(false);
  });
});

describe("runner apiStartTime contract", () => {
  it("accepts Unix epoch millisecond integers", () => {
    const timestamp = 1_700_000_000_000;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(true);
  });

  it("rejects fractional timestamps", () => {
    const timestamp = 1_700_000_000_000.5;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(false);
  });

  it("rejects negative timestamps", () => {
    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(-1).success,
    ).toBe(false);
  });

  it("rejects seconds-shaped timestamps", () => {
    const timestamp = 1_700_000_000;

    expect(
      storedExecutionContextSchema.shape.apiStartTime.safeParse(timestamp)
        .success,
    ).toBe(false);
    expect(
      executionContextSchema.shape.apiStartTime.safeParse(timestamp).success,
    ).toBe(false);
  });

  it("computes elapsed milliseconds for valid apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000_000, 1_700_000_001_250)).toBe(
      1_250,
    );
  });

  it("clamps future apiStartTime values to zero elapsed milliseconds", () => {
    expect(elapsedSinceApiStartMs(1_700_000_001_250, 1_700_000_000_000)).toBe(
      0,
    );
  });

  it("skips seconds-shaped apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000, 1_700_000_001_250)).toBe(
      undefined,
    );
  });

  it("skips fractional apiStartTime values", () => {
    expect(elapsedSinceApiStartMs(1_700_000_000_000.5, 1_700_000_001_250)).toBe(
      undefined,
    );
  });
});

describe("runner Claude tool list contracts", () => {
  it("keeps runner context schemas tolerant of legacy tool list values", () => {
    expect(
      storedExecutionContextSchema.shape.tools.safeParse(["Bash,Read"]).success,
    ).toBe(true);
    expect(
      executionContextSchema.shape.tools.safeParse(["Bash,Read"]).success,
    ).toBe(true);
  });
});
