import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  getCustomSkillStorageName,
  VOLUME_ORG_USER_ID,
} from "@vm0/core/storage-names";
import { command } from "ccstate";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { eq } from "drizzle-orm";

import type { TestContext } from "../../../../__tests__/test-helpers";
import { writeDb$ } from "../../../external/db";

export interface SkillsFixture {
  readonly orgId: string;
  readonly userId: string;
}

export const seedSkillsFixture$ = command(
  (_, _input: void, _signal: AbortSignal): Promise<SkillsFixture> => {
    return Promise.resolve({
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    });
  },
);

export const deleteSkillsForFixture$ = command(
  async (
    { set },
    fixture: SkillsFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    // Storage cascade deletes storage_versions via FK.
    await db.delete(storages).where(eq(storages.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.delete(zeroSkills).where(eq(zeroSkills.orgId, fixture.orgId));
    signal.throwIfAborted();
    // agent_composes cascades to zero_agents via FK.
    await db
      .delete(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

export const seedSkill$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      name: string;
      displayName?: string | null;
      description?: string | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.insert(zeroSkills).values({
      orgId: args.orgId,
      name: args.name,
      displayName: args.displayName ?? null,
      description: args.description ?? null,
      createdBy: args.userId,
    });
    signal.throwIfAborted();
  },
);

interface SkillStorageSeed {
  readonly orgId: string;
  readonly userId: string;
  readonly skillName: string;
  readonly s3Key: string;
  readonly headVersionId: string;
}

export const seedSkillStorage$ = command(
  async (
    { set },
    args: SkillStorageSeed,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const storageId = randomUUID();
    const storageName = getCustomSkillStorageName(args.skillName);

    await db.insert(storages).values({
      id: storageId,
      userId: VOLUME_ORG_USER_ID,
      name: storageName,
      type: "volume",
      orgId: args.orgId,
      s3Prefix: `orgs/${args.orgId}/${storageName}`,
    });
    signal.throwIfAborted();

    await db.insert(storageVersions).values({
      id: args.headVersionId,
      storageId,
      s3Key: args.s3Key,
      createdBy: args.userId,
    });
    signal.throwIfAborted();

    await db
      .update(storages)
      .set({ headVersionId: args.headVersionId })
      .where(eq(storages.id, storageId));
    signal.throwIfAborted();
  },
);

interface SkillContentMockExtra {
  readonly path: string;
  readonly size: number;
}

interface SkillContentMockArgs {
  readonly s3Key: string;
  readonly content: string;
  readonly extraFiles?: readonly SkillContentMockExtra[];
}

const TAR_BLOCK_SIZE = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function createSingleFileTarGz(filename: string, content: Buffer): Buffer {
  // POSIX tar header (USTAR-compatible) — sufficient for extractFileFromTarGz
  // to parse the filename + size + payload.
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  header.write(filename, 0, 100, "utf8");
  header.write("0000644\0", 100); // mode
  header.write("0000000\0", 108); // uid
  header.write("0000000\0", 116); // gid
  header.write(octal(content.length, 12), 124); // size
  header.write(octal(0, 12), 136); // mtime
  // Checksum placeholder — 8 spaces — required so the checksum sum is correct.
  header.write("        ", 148);
  header.write("0", 156); // type flag (regular file)

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  // Final checksum: 6 octal digits, NUL, space.
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);

  const padding = TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE);
  const dataBlocks =
    padding < TAR_BLOCK_SIZE
      ? Buffer.concat([content, Buffer.alloc(padding)])
      : content;
  const eofBlocks = Buffer.alloc(TAR_BLOCK_SIZE * 2);

  return gzipSync(Buffer.concat([header, dataBlocks, eofBlocks]));
}

function asyncIterableOf(buffer: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
  };
}

function commandKey(command: unknown): string {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command)
  ) {
    return "";
  }
  const input = (command as { input: unknown }).input;
  if (
    typeof input !== "object" ||
    input === null ||
    !("Key" in input) ||
    typeof (input as { Key: unknown }).Key !== "string"
  ) {
    return "";
  }
  return (input as { Key: string }).Key;
}

export function mockSkillContent(
  context: TestContext,
  args: SkillContentMockArgs,
): void {
  const contentBuffer = Buffer.from(args.content, "utf8");
  const archive = createSingleFileTarGz("SKILL.md", contentBuffer);

  const manifest = {
    version: "test-version",
    createdAt: new Date(0).toISOString(),
    files: [
      { path: "SKILL.md", hash: "test-hash-skill", size: contentBuffer.length },
      ...(args.extraFiles ?? []).map((f) => {
        return { path: f.path, hash: "test-hash-extra", size: f.size };
      }),
    ],
    totalSize:
      contentBuffer.length +
      (args.extraFiles ?? []).reduce((sum, f) => {
        return sum + f.size;
      }, 0),
    fileCount: 1 + (args.extraFiles ?? []).length,
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");

  context.mocks.s3.send.mockImplementation((cmd: unknown): Promise<unknown> => {
    const key = commandKey(cmd);
    if (key === `${args.s3Key}/manifest.json`) {
      return Promise.resolve({ Body: asyncIterableOf(manifestBuffer) });
    }
    if (key === `${args.s3Key}/archive.tar.gz`) {
      return Promise.resolve({ Body: asyncIterableOf(archive) });
    }
    return Promise.resolve({});
  });
}

export const seedAgentForInstructions$ = command(
  async (
    { set },
    args: {
      orgId: string;
      userId: string;
      name?: string;
      displayName?: string | null;
      description?: string | null;
      sound?: string | null;
    },
    signal: AbortSignal,
  ): Promise<{ agentId: string }> => {
    const db = set(writeDb$);
    const agentId = randomUUID();
    const name = args.name ?? `agent-${randomUUID().slice(0, 8)}`;
    await db.insert(agentComposes).values({
      id: agentId,
      userId: args.userId,
      orgId: args.orgId,
      name,
    });
    signal.throwIfAborted();
    await db
      .insert(zeroAgents)
      .values({
        id: agentId,
        orgId: args.orgId,
        owner: args.userId,
        name,
        displayName: args.displayName ?? null,
        description: args.description ?? null,
        sound: args.sound ?? null,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    return { agentId };
  },
);
