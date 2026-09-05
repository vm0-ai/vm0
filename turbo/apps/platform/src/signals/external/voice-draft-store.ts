import { openDB, type DBSchema } from "idb";
import { observeClientOperation } from "../../lib/client-telemetry.ts";
import { withCleanup } from "../utils.ts";
import { runIndexedDbTransaction } from "./indexeddb-client.ts";

export interface VoiceDraftRecordingRecord {
  readonly id: string;
  readonly blob: Blob;
}

interface VoiceDraftRecordingDatabase extends DBSchema {
  readonly drafts: {
    readonly key: string;
    readonly value: {
      readonly id: string;
      readonly audio: ArrayBuffer;
      readonly contentType: string;
    };
  };
}

const DATABASE_NAME = "okou-voice-drafts";
const DATABASE_VERSION = 1;
const TRANSACTION_TEMPLATES = {
  delete: "voice_drafts.delete",
  read: "voice_drafts.get",
  save: "voice_drafts.put",
} as const;

async function openVoiceDraftRecordingDatabase() {
  return await observeClientOperation(
    { event_name: "indexeddb.open", database: "voice_drafts" },
    () => {
      return openDB<VoiceDraftRecordingDatabase>(
        DATABASE_NAME,
        DATABASE_VERSION,
        {
          upgrade(database) {
            database.createObjectStore("drafts");
          },
        },
      );
    },
  );
}

export async function readVoiceDraftRecording(
  key: string,
): Promise<VoiceDraftRecordingRecord | null> {
  const database = await openVoiceDraftRecordingDatabase();
  const draft = await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: TRANSACTION_TEMPLATES.read,
        transaction_mode: "readonly",
      },
      () => {
        return database.transaction("drafts", "readonly");
      },
      async (transaction, trackRequest) => {
        return await trackRequest(transaction.store.get(key));
      },
    ),
    () => {
      database.close();
    },
  );
  if (!draft) {
    return null;
  }
  return {
    id: draft.id,
    blob: new Blob([draft.audio], { type: draft.contentType }),
  };
}

export async function saveVoiceDraftRecording(
  key: string,
  draft: VoiceDraftRecordingRecord,
): Promise<void> {
  const audio = await draft.blob.arrayBuffer();
  const database = await openVoiceDraftRecordingDatabase();
  await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: TRANSACTION_TEMPLATES.save,
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction("drafts", "readwrite");
      },
      async (transaction, trackRequest) => {
        await trackRequest(
          transaction.store.put(
            { id: draft.id, audio, contentType: draft.blob.type },
            key,
          ),
        );
      },
    ),
    () => {
      database.close();
    },
  );
}

export async function deleteVoiceDraftRecording(
  key: string,
  id: string,
): Promise<void> {
  const database = await openVoiceDraftRecordingDatabase();
  await withCleanup(
    runIndexedDbTransaction(
      {
        database: "voice_drafts",
        template: TRANSACTION_TEMPLATES.delete,
        transaction_mode: "readwrite",
      },
      () => {
        return database.transaction("drafts", "readwrite");
      },
      async (transaction, trackRequest) => {
        const current = await trackRequest(transaction.store.get(key));
        if (current?.id === id) {
          await trackRequest(transaction.store.delete(key));
        }
      },
    ),
    () => {
      database.close();
    },
  );
}
