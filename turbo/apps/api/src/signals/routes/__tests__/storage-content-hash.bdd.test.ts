import { createHash } from "node:crypto";

import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import contentHashContract from "../../../test-fixtures/storage-content-hash-contract.json";
import { createBddApi } from "./helpers/api-bdd";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";

const context = testContext();
const STORAGE_NAME = "content-hash-contract";

interface ContractFile {
  readonly path?: string;
  readonly pathUtf16?: readonly number[];
  readonly content: string;
  readonly hash: string;
  readonly size: number;
}

function materializePath(file: ContractFile): string {
  if (file.path !== undefined) {
    return file.path;
  }
  if (file.pathUtf16 === undefined) {
    throw new Error("Content hash fixture file has no path representation");
  }
  return String.fromCharCode(...file.pathUtf16);
}

function materializeFiles(files: readonly ContractFile[]) {
  return files.map((file) => {
    expect(createHash("sha256").update(file.content).digest("hex")).toBe(
      file.hash,
    );
    expect(Buffer.byteLength(file.content)).toBe(file.size);
    return {
      path: materializePath(file),
      hash: file.hash,
      size: file.size,
    };
  });
}

function contractCase(name: string) {
  const found = contentHashContract.cases.find((entry) => {
    return entry.name === name;
  });
  if (!found) {
    throw new Error(`Missing content hash contract case: ${name}`);
  }
  return found;
}

describe("storage content hash contract", () => {
  it("keeps prepare on v1 while commit accepts canonical v2", async () => {
    const bdd = createBddApi(context);
    const storages = createStoragesBddApi(context);
    const actor = bdd.user({
      userId: "user_storage_content_hash_contract",
      orgId: "org_storage_content_hash_contract",
    });
    const storageIdentity: {
      readonly name: string;
      readonly owner: "user";
    } = { name: STORAGE_NAME, owner: "user" };

    await storages.deleteStorage(actor, storageIdentity);
    onTestFinished(async () => {
      await storages.deleteStorage(actor, storageIdentity);
    });
    storages.mockStoragePresignedUrls();
    storages.mockStorageObjectsExist();

    for (const entry of contentHashContract.cases) {
      const files = materializeFiles(entry.files);
      const prepared = await storages.prepareStorage(actor, {
        storageName: STORAGE_NAME,
        storageOwner: "user",
        storageId: contentHashContract.storageId,
        files,
        force: true,
      });
      expect(prepared.versionId).toBe(entry.expectedV1);

      const committed = await storages.commitStorage(actor, {
        storageName: STORAGE_NAME,
        storageOwner: "user",
        versionId: entry.expectedV2,
        files,
      });
      expect(committed).toMatchObject({
        success: true,
        versionId: entry.expectedV2,
        headVersionId: entry.expectedV2,
        storageName: STORAGE_NAME,
        size: files.reduce((sum, file) => {
          return sum + file.size;
        }, 0),
        fileCount: files.length,
      });
    }

    const twoFiles = contractCase("collision-two-files");
    const reversed = contractCase("reversed-order");
    const newlinePath = contractCase("collision-newline-path");
    expect(twoFiles.expectedV1).toBe(newlinePath.expectedV1);
    expect(twoFiles.expectedV2).not.toBe(newlinePath.expectedV2);
    expect(twoFiles.expectedV2).toBe(reversed.expectedV2);

    const replacement = contractCase("replacement-character-path");
    const loneSurrogate = contractCase("lone-surrogate-path");
    expect(replacement.expectedV1).toBe(loneSurrogate.expectedV1);
    expect(replacement.expectedV2).not.toBe(loneSurrogate.expectedV2);

    await expect(
      storages.commitStorage(actor, {
        storageName: STORAGE_NAME,
        storageOwner: "user",
        versionId: "f".repeat(64),
        files: materializeFiles(contractCase("single").files),
      }),
    ).rejects.toThrow("Storage state action commit failed with 400");
  });
});
