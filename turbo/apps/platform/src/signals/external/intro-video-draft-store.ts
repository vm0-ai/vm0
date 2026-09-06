import { openDB, type DBSchema } from "idb";

import { observeClientOperation } from "../../lib/client-telemetry.ts";
import { withCleanup } from "../utils.ts";
import { runIndexedDbTransaction } from "./indexeddb-client.ts";

/**
 * Which entry of the source step the user came in through, which is all the
 * wizard knows about a source until an agent opens it.
 */
type IntroVideoSourceKind = "file" | "presentation" | "video";

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

interface IntroVideoDraftRecord {
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

/**
 * Client-persisted identity, deliberately kept under the pre-rename name.
 *
 * The browser keys an IndexedDB database by this string. Renaming it does not
 * move the stored drafts: the old database keeps the user's saved blob and this
 * build opens an empty new one, so every draft saved before the rename is
 * silently lost. Copying them across would mean opening both databases, moving
 * blobs, and deleting the old one on every client that ever returns — and a
 * client that never returns keeps an orphaned database forever. The name is
 * invisible to users, so #31816 keeps it. Rename it only as part of a slice
 * that already has to restructure this store and can carry the copy.
 */
const DATABASE_NAME = "zero-intro-video-drafts";
const DATABASE_VERSION = 1;
const TRANSACTION_TEMPLATES = {
  delete: "intro_video_drafts.delete",
  read: "intro_video_drafts.get",
  save: "intro_video_drafts.put",
} as const;

async function openIntroVideoDraftDatabase() {
  return await observeClientOperation(
    { event_name: "indexeddb.open", database: "intro_video_drafts" },
    () => {
      return openDB<IntroVideoDraftDatabase>(DATABASE_NAME, DATABASE_VERSION, {
        upgrade(database) {
          database.createObjectStore("drafts");
        },
      });
    },
  );
}

export async function readIntroVideoDraft(): Promise<IntroVideoDraftRecord | null> {
  const database = await openIntroVideoDraftDatabase();
  const draft = await withCleanup(
    runIndexedDbTransaction(
      {
        database: "intro_video_drafts",
        template: TRANSACTION_TEMPLATES.read,
        transaction_mode: "readonly",
      },
      () => {
        return database.transaction("drafts", "readonly");
      },
      async (transaction, trackRequest) => {
        return await trackRequest(transaction.store.get("latest"));
      },
    ),
    () => {
      database.close();
    },
  );
  if (!draft) {
    return null;
  }
  return { ...draft, kind: knownKind(draft.kind) };
}

export async function saveIntroVideoDraft(
  draft: IntroVideoDraftRecord,
): Promise<void> {
  const database = await openIntroVideoDraftDatabase();
  await withCleanup(
    runIndexedDbTransaction(
      {
        database: "intro_video_drafts",
        template: TRANSACTION_TEMPLATES.save,
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction("drafts", "readwrite");
      },
      async (transaction, trackRequest) => {
        await trackRequest(transaction.store.put(draft, "latest"));
      },
    ),
    () => {
      database.close();
    },
  );
}

export async function deleteIntroVideoDraft(): Promise<void> {
  const database = await openIntroVideoDraftDatabase();
  await withCleanup(
    runIndexedDbTransaction(
      {
        database: "intro_video_drafts",
        template: TRANSACTION_TEMPLATES.delete,
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction("drafts", "readwrite");
      },
      async (transaction, trackRequest) => {
        await trackRequest(transaction.store.delete("latest"));
      },
    ),
    () => {
      database.close();
    },
  );
}
