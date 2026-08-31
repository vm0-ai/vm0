interface StoredRecording {
  readonly blob: Blob;
  readonly contentType: string;
  readonly createdAt: number;
  readonly durationSeconds: number;
  readonly name: string;
  readonly sessionId: string;
}

const DATABASE_NAME = "okou-screen-recorder";
const DATABASE_VERSION = 1;
const RECORDINGS_STORE = "recordings";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECORDINGS_STORE)) {
        database.createObjectStore(RECORDINGS_STORE, {
          keyPath: "sessionId",
        });
      }
    });
    request.addEventListener("success", () => {
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Could not open the recording store"));
    });
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => {
      resolve();
    });
    transaction.addEventListener("abort", () => {
      reject(
        transaction.error ?? new Error("The recording transaction aborted"),
      );
    });
    transaction.addEventListener("error", () => {
      reject(
        transaction.error ?? new Error("The recording transaction failed"),
      );
    });
  });
}

export async function saveRecording(recording: StoredRecording): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(RECORDINGS_STORE, "readwrite");
  transaction.objectStore(RECORDINGS_STORE).put(recording);
  await transactionCompletion(transaction);
  database.close();
}

export async function readRecording(
  sessionId: string,
): Promise<StoredRecording | null> {
  const database = await openDatabase();
  const transaction = database.transaction(RECORDINGS_STORE, "readonly");
  const request = transaction.objectStore(RECORDINGS_STORE).get(sessionId);
  const value = await new Promise<StoredRecording | null>((resolve, reject) => {
    request.addEventListener("success", () => {
      resolve((request.result as StoredRecording | undefined) ?? null);
    });
    request.addEventListener("error", () => {
      reject(request.error ?? new Error("Could not read the recording"));
    });
  });
  await transactionCompletion(transaction);
  database.close();
  return value;
}

export async function deleteRecording(sessionId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(RECORDINGS_STORE, "readwrite");
  transaction.objectStore(RECORDINGS_STORE).delete(sessionId);
  await transactionCompletion(transaction);
  database.close();
}
