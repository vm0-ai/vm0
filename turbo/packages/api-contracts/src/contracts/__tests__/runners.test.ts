import { describe, expect, it } from "vitest";

import {
  elapsedSinceApiStartMs,
  executionContextSchema,
  storageManifestSchema,
  storageProvisioningManifestSchema,
  storedExecutionContextSchema,
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
            manifestUrl: "https://storage.example/manifest.json",
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
          manifestUrl: "https://storage.example/manifest.json",
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
          manifestUrl: "https://storage.example/manifest.json",
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

  it("accepts typed storage provisioning manifests", () => {
    expect(
      storageProvisioningManifestSchema.parse({
        version: "2",
        entries: [
          {
            intent: "user-volume",
            source: {
              kind: "storage",
              name: "docs",
              vasStorageName: "docs",
              vasVersionId: "version-1",
              archiveUrl: "https://storage.example/docs.tar.gz",
            },
            destination: {
              type: "mnt",
              name: "docs",
              subPath: "guides",
            },
          },
          {
            intent: "user-artifact",
            source: {
              kind: "artifact",
              name: "workspace",
              vasStorageName: "workspace",
              vasStorageId: "storage-id-1",
              vasVersionId: "version-2",
              archiveUrl: "https://storage.example/workspace.tar.gz",
              manifestUrl: "https://storage.example/workspace.json",
            },
            destination: {
              type: "workspace",
              subPath: "project",
            },
            missingRootPolicy: "fail",
          },
          {
            intent: "instructions",
            source: {
              kind: "storage",
              name: "instructions",
              vasStorageName: "instructions",
              vasVersionId: "version-3",
              archiveUrl: "https://storage.example/instructions.tar.gz",
            },
            destination: {
              type: "framework-instructions",
              framework: "codex",
            },
            instructionsTargetFilename: "AGENTS.md",
          },
          {
            intent: "skill",
            source: {
              kind: "storage",
              name: "research-kit",
              vasStorageName: "research-kit",
              vasVersionId: "version-4",
              archiveUrl: "https://storage.example/skill.tar.gz",
            },
            destination: {
              type: "framework-skill",
              framework: "claude-code",
              skillName: "research-kit",
            },
          },
          {
            intent: "memory",
            source: {
              kind: "artifact",
              name: "memory",
              vasStorageName: "memory",
              vasStorageId: "storage-id-2",
              vasVersionId: "version-5",
              archiveUrl: "https://storage.example/memory.tar.gz",
              manifestUrl: "https://storage.example/memory.json",
            },
            destination: {
              type: "framework-memory",
              framework: "codex",
            },
            missingRootPolicy: "preserveParentVersion",
          },
        ],
      }),
    ).toMatchObject({
      version: "2",
      entries: [
        {
          intent: "user-volume",
          destination: {
            type: "mnt",
            name: "docs",
            subPath: "guides",
          },
        },
        {
          intent: "user-artifact",
          source: {
            vasStorageId: "storage-id-1",
          },
          destination: {
            type: "workspace",
            subPath: "project",
          },
        },
        {
          intent: "instructions",
          destination: {
            type: "framework-instructions",
            framework: "codex",
          },
        },
        {
          intent: "skill",
          destination: {
            type: "framework-skill",
            framework: "claude-code",
            skillName: "research-kit",
          },
        },
        {
          intent: "memory",
          destination: {
            type: "framework-memory",
            framework: "codex",
          },
        },
      ],
    });
  });

  it("rejects invalid storage provisioning destination shapes", () => {
    const result = storageProvisioningManifestSchema.safeParse({
      version: "2",
      entries: [
        {
          intent: "skill",
          source: {
            kind: "storage",
            name: "research-kit",
            vasStorageName: "research-kit",
            vasVersionId: "version-1",
            archiveUrl: "https://storage.example/skill.tar.gz",
          },
          destination: {
            type: "framework-skill",
            framework: "claude-code",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsafe storage provisioning destination path components", () => {
    for (const destination of [
      {
        type: "workspace",
        subPath: "../secrets",
      },
      {
        type: "workspace",
        subPath: "reports//today",
      },
      {
        type: "mnt",
        name: ".",
      },
      {
        type: "mnt",
        name: "docs",
        subPath: "/absolute",
      },
      {
        type: "framework-skill",
        framework: "codex",
        skillName: "research/notes",
      },
    ]) {
      const result = storageProvisioningManifestSchema.safeParse({
        version: "2",
        entries: [
          {
            intent:
              destination.type === "framework-skill" ? "skill" : "user-volume",
            source: {
              kind: "storage",
              name: "docs",
              vasStorageName: "docs",
              vasVersionId: "version-1",
              archiveUrl: "https://storage.example/docs.tar.gz",
            },
            destination,
          },
        ],
      });

      expect(result.success).toBe(false);
    }
  });

  it("rejects artifact provisioning sources without storage ids", () => {
    const result = storageProvisioningManifestSchema.safeParse({
      version: "2",
      entries: [
        {
          intent: "user-artifact",
          source: {
            kind: "artifact",
            name: "workspace",
            vasStorageName: "workspace",
            vasVersionId: "version-1",
            archiveUrl: "https://storage.example/workspace.tar.gz",
          },
          destination: {
            type: "workspace",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate storage provisioning destinations", () => {
    const result = storageProvisioningManifestSchema.safeParse({
      version: "2",
      entries: [
        {
          intent: "user-volume",
          source: {
            kind: "storage",
            name: "workspace",
            vasStorageName: "workspace",
            vasVersionId: "version-1",
            archiveUrl: "https://storage.example/workspace.tar.gz",
          },
          destination: {
            type: "workspace",
            subPath: "shared",
          },
        },
        {
          intent: "user-artifact",
          source: {
            kind: "artifact",
            name: "report",
            vasStorageName: "report",
            vasStorageId: "storage-id-1",
            vasVersionId: "version-2",
            archiveUrl: "https://storage.example/report.tar.gz",
          },
          destination: {
            type: "workspace",
            subPath: "shared",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects intent and destination mismatches", () => {
    const result = storageProvisioningManifestSchema.safeParse({
      version: "2",
      entries: [
        {
          intent: "user-volume",
          source: {
            kind: "storage",
            name: "docs",
            vasStorageName: "docs",
            vasVersionId: "version-1",
            archiveUrl: "https://storage.example/docs.tar.gz",
          },
          destination: {
            type: "framework-skill",
            framework: "codex",
            skillName: "docs",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects instruction entries without canonical target filenames", () => {
    expect(
      storageProvisioningManifestSchema.safeParse({
        version: "2",
        entries: [
          {
            intent: "instructions",
            source: {
              kind: "storage",
              name: "instructions",
              vasStorageName: "instructions",
              vasVersionId: "version-1",
              archiveUrl: "https://storage.example/instructions.tar.gz",
            },
            destination: {
              type: "framework-instructions",
              framework: "codex",
            },
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      storageProvisioningManifestSchema.safeParse({
        version: "2",
        entries: [
          {
            intent: "instructions",
            source: {
              kind: "storage",
              name: "instructions",
              vasStorageName: "instructions",
              vasVersionId: "version-1",
              archiveUrl: "https://storage.example/instructions.tar.gz",
            },
            destination: {
              type: "framework-instructions",
              framework: "codex",
            },
            instructionsTargetFilename: "../CLAUDE.md",
          },
        ],
      }).success,
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
