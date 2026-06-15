import { getCustomSkillStorageName } from "@vm0/core/storage-names";
import { zeroSkills } from "@vm0/db/schema/zero-skill";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { uploadVolumeServerSide$ } from "./storage-volume-upload.service";

interface SkillFileInput {
  readonly path: string;
  readonly content: string;
}

interface UpdateZeroSkillInput {
  readonly orgId: string;
  readonly skillName: string;
  readonly files: readonly SkillFileInput[];
}

interface UpdatedZeroSkill {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly content: string | null;
  readonly files: readonly { readonly path: string; readonly size: number }[];
}

export const updateZeroSkill$ = command(
  async (
    { set },
    args: UpdateZeroSkillInput,
    signal: AbortSignal,
  ): Promise<UpdatedZeroSkill | null> => {
    const writeDb = set(writeDb$);
    const [skill] = await writeDb
      .select()
      .from(zeroSkills)
      .where(
        and(
          eq(zeroSkills.orgId, args.orgId),
          eq(zeroSkills.name, args.skillName),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!skill) {
      return null;
    }

    await set(
      uploadVolumeServerSide$,
      {
        orgId: args.orgId,
        storageName: getCustomSkillStorageName(args.skillName),
        files: args.files,
      },
      signal,
    );
    signal.throwIfAborted();

    await writeDb
      .update(zeroSkills)
      .set({ updatedAt: nowDate() })
      .where(eq(zeroSkills.id, skill.id));
    signal.throwIfAborted();

    const skillFile = args.files.find((file) => {
      return file.path === "SKILL.md";
    });

    return {
      name: skill.name,
      displayName: skill.displayName ?? null,
      description: skill.description ?? null,
      content: skillFile?.content ?? null,
      files: args.files.map((file) => {
        return {
          path: file.path,
          size: Buffer.byteLength(file.content, "utf8"),
        };
      }),
    };
  },
);
