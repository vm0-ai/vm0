import { openDB, type DBSchema } from "idb";

/**
 * Which entry of the source step the user came in through, which is all the
 * wizard knows about a source until an agent opens it.
 */
export type IntroVideoSourceKind = "file" | "presentation" | "video";

/**
 * The kind a stored draft names.
 *
 * A tab that was open across a deploy can have written a kind this build does
 * not know, and the generic kind is the one that assumes nothing about the
 * source, so an unrecognized name lands there rather than throwing the draft
 * away.
 */
function knownKind(kind: string): IntroVideoSourceKind {
  switch (kind) {
    case "presentation": {
      return "presentation";
    }
    case "video": {
      return "video";
    }
    default: {
      return "file";
    }
  }
}

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
  if (!draft) {
    return null;
  }
  return { ...draft, kind: knownKind(draft.kind) };
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
