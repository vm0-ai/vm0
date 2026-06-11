import { describe, expect, it } from "vitest";

import {
  elapsedSinceApiStartMs,
  executionContextSchema,
  storageManifestSchema,
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
