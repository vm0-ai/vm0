import { describe, expect, it } from "vitest";

import { storageManifestSchema } from "../runners";

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
