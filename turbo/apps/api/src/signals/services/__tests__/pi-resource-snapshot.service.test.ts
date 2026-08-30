import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANONICAL_WORKING_DIR,
  PI_AGENT_DIR,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import { create as createTar } from "tar";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  buildPiResourceSnapshot,
  piResourceDiscoveryMounts,
  piResourceSnapshotDigest,
  UnsupportedPiResourceError,
} from "../pi-resource-snapshot.service";

interface ArchiveFile {
  readonly path: string;
  readonly content: string | Buffer;
}

function archive(files: readonly ArchiveFile[]): Buffer {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-archive-"));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const file of files) {
    const filePath = join(root, file.path);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, file.content);
  }
  const archivePath = join(root, "resources.tar.gz");
  createTar(
    {
      cwd: root,
      file: archivePath,
      gzip: true,
      sync: true,
    },
    files.map((file) => {
      return file.path;
    }),
  );
  return readFileSync(archivePath);
}

function mount(args: {
  readonly name: string;
  readonly versionId: string;
  readonly mountPath: string;
  readonly archive: Buffer;
  readonly archiveUrl?: string;
}): StoredStorageMountEntry {
  return {
    name: args.name,
    storageId: `${args.name}-storage`,
    versionId: args.versionId,
    mountPath: args.mountPath,
    archiveUrl:
      args.archiveUrl ?? `https://storage.example/${args.name}.tar.gz`,
    archiveSize: args.archive.length,
    orgId: "test-org",
    userId: "test-user",
  };
}

describe("Pi resource snapshot", () => {
  it("replays Pi context and skill discovery from mounted archives", () => {
    const userArchive = archive([
      { path: "AGENTS.md", content: "Global Pi instructions." },
      {
        path: "skills/.gitignore",
        content: "ignored/\n",
      },
      {
        path: "skills/release-check/SKILL.md",
        content:
          "---\nname: release-check\ndescription: Inspect a release.\n---\nBody stays in Storage.\n",
      },
      {
        path: "skills/manual-only/SKILL.md",
        content:
          "---\nname: manual-only\ndescription: Explicit invocation only.\ndisable-model-invocation: true\n---\n",
      },
      {
        path: "skills/ignored/SKILL.md",
        content:
          "---\nname: ignored\ndescription: Must not be discovered.\n---\n",
      },
    ]);
    const projectArchive = archive([
      {
        path: "AGENTS.override.md",
        content: "Project Pi instructions.",
      },
      {
        path: ".pi/skills/project-check/SKILL.md",
        content:
          "---\nname: project-check\ndescription: Inspect this project.\n---\n",
      },
    ]);
    const mounts = [
      mount({
        name: "pi-agent",
        versionId: "agent-v1",
        mountPath: PI_AGENT_DIR,
        archive: userArchive,
      }),
      mount({
        name: "workspace",
        versionId: "workspace-v1",
        mountPath: CANONICAL_WORKING_DIR,
        archive: projectArchive,
      }),
    ];

    const snapshot = buildPiResourceSnapshot(mounts, [
      userArchive,
      projectArchive,
    ]);

    expect(snapshot.agentsFiles).toStrictEqual([
      {
        path: `${PI_AGENT_DIR}/AGENTS.md`,
        content: "Global Pi instructions.",
      },
      {
        path: `${CANONICAL_WORKING_DIR}/AGENTS.override.md`,
        content: "Project Pi instructions.",
      },
    ]);
    expect(snapshot.skills).toStrictEqual([
      {
        name: "manual-only",
        description: "Explicit invocation only.",
        filePath: `${PI_AGENT_DIR}/skills/manual-only/SKILL.md`,
        baseDir: `${PI_AGENT_DIR}/skills/manual-only`,
        scope: "user",
        disableModelInvocation: true,
      },
      {
        name: "release-check",
        description: "Inspect a release.",
        filePath: `${PI_AGENT_DIR}/skills/release-check/SKILL.md`,
        baseDir: `${PI_AGENT_DIR}/skills/release-check`,
        scope: "user",
        disableModelInvocation: false,
      },
      {
        name: "project-check",
        description: "Inspect this project.",
        filePath: `${CANONICAL_WORKING_DIR}/.pi/skills/project-check/SKILL.md`,
        baseDir: `${CANONICAL_WORKING_DIR}/.pi/skills/project-check`,
        scope: "project",
        disableModelInvocation: false,
      },
    ]);
  });

  it("ignores adjacent binary assets and discovers PAX long-path skills", () => {
    const nestedPath = Array.from({ length: 8 }, (_, index) => {
      return `nested-${index}-${"x".repeat(28)}`;
    }).join("/");
    const skillPath = `skills/${nestedPath}/long-path-skill/SKILL.md`;
    expect(Buffer.byteLength(skillPath, "utf8")).toBeGreaterThan(255);
    const resourceArchive = archive([
      {
        path: skillPath,
        content:
          "---\nname: pax-long-path\ndescription: Discover a PAX path.\n---\n",
      },
      {
        path: `skills/${nestedPath}/long-path-skill/icon.png`,
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
      },
    ]);
    const mounts = [
      mount({
        name: "pi-agent",
        versionId: "agent-pax-v1",
        mountPath: PI_AGENT_DIR,
        archive: resourceArchive,
      }),
    ];

    expect(
      buildPiResourceSnapshot(mounts, [resourceArchive]).skills,
    ).toStrictEqual([
      {
        name: "pax-long-path",
        description: "Discover a PAX path.",
        filePath: `${PI_AGENT_DIR}/${skillPath}`,
        baseDir: `${PI_AGENT_DIR}/${skillPath.replace(/\/SKILL\.md$/u, "")}`,
        scope: "user",
        disableModelInvocation: false,
      },
    ]);
  });

  it("keys the durable snapshot by ordered Storage versions, not signed URLs", () => {
    const emptyArchive = archive([{ path: "README.md", content: "none" }]);
    const first = mount({
      name: "workspace",
      versionId: "workspace-v1",
      mountPath: CANONICAL_WORKING_DIR,
      archive: emptyArchive,
      archiveUrl: "https://storage.example/first-signature",
    });
    const refreshedUrl = {
      ...first,
      archiveUrl: "https://storage.example/refreshed-signature",
    };
    expect(piResourceSnapshotDigest([first])).toBe(
      piResourceSnapshotDigest([refreshedUrl]),
    );
    expect(piResourceSnapshotDigest([first])).not.toBe(
      piResourceSnapshotDigest([{ ...first, versionId: "workspace-v2" }]),
    );

    const artifact = mount({
      name: "artifact",
      versionId: "artifact-v1",
      mountPath: `${CANONICAL_WORKING_DIR}/artifacts`,
      archive: emptyArchive,
    });
    expect(piResourceDiscoveryMounts([first, artifact])).toStrictEqual([first]);
  });

  it("fails with an unsupported resource error for settings", () => {
    const settingsArchive = archive([
      { path: "settings.json", content: '{"packages":["custom"]}' },
    ]);
    const mounts = [
      mount({
        name: "pi-agent",
        versionId: "agent-v1",
        mountPath: PI_AGENT_DIR,
        archive: settingsArchive,
      }),
    ];
    expect(() => {
      return buildPiResourceSnapshot(mounts, [settingsArchive]);
    }).toThrow(UnsupportedPiResourceError);
  });

  it("rejects invalid UTF-8 instead of approximating Pi discovery", () => {
    const invalidArchive = archive([
      {
        path: "skills/invalid/SKILL.md",
        content: Buffer.from([0xff, 0xfe]),
      },
    ]);
    const mounts = [
      mount({
        name: "pi-agent",
        versionId: "agent-invalid-utf8",
        mountPath: PI_AGENT_DIR,
        archive: invalidArchive,
      }),
    ];

    expect(() => {
      return buildPiResourceSnapshot(mounts, [invalidArchive]);
    }).toThrow(/valid for encoding utf-8/u);
  });
});
