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
