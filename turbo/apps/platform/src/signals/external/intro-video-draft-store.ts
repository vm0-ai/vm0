import { openDB, type DBSchema } from "idb";

export type IntroVideoSourceKind = "document" | "recording";

export interface IntroVideoDraftRecord {
  readonly blob: Blob;
  readonly contentType: string;
  readonly createdAt: number;
  readonly durationSeconds: number | null;
  readonly kind: IntroVideoSourceKind;
  readonly name: string;
}

interface IntroVideoDraftDatabase extends DBSchema {
  readonly drafts: {
    readonly key: "latest";
    readonly value: IntroVideoDraftRecord;
  };
}

const DATABASE_NAME = "zero-intro-video-drafts";
const DATABASE_VERSION = 1;

async function openIntroVideoDraftDatabase() {
  return await openDB<IntroVideoDraftDatabase>(
    DATABASE_NAME,
    DATABASE_VERSION,
    {
      upgrade(database) {
        database.createObjectStore("drafts");
      },
    },
  );
}

export async function readIntroVideoDraft(): Promise<IntroVideoDraftRecord | null> {
  const database = await openIntroVideoDraftDatabase();
  const draft = await database.get("drafts", "latest");
  database.close();
  return draft ?? null;
}

export async function saveIntroVideoDraft(
  draft: IntroVideoDraftRecord,
): Promise<void> {
  const database = await openIntroVideoDraftDatabase();
  await database.put("drafts", draft, "latest");
  database.close();
}

export async function deleteIntroVideoDraft(): Promise<void> {
  const database = await openIntroVideoDraftDatabase();
  await database.delete("drafts", "latest");
  database.close();
}
