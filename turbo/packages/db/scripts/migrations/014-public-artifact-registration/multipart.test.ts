import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  type MultipartUpload,
} from "@aws-sdk/client-s3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runMultipartPreflight } from "./multipart";

const directories: string[] = [];

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", undefined);
  vi.stubEnv("R2_ACCOUNT_ID", "test-account");
  vi.stubEnv("R2_USER_ARTIFACTS_BUCKET_NAME", "public");
  vi.stubEnv("R2_USER_ARTIFACTS_ACCESS_KEY_ID", "test-public-id");
  vi.stubEnv("R2_USER_ARTIFACTS_SECRET_ACCESS_KEY", "test-public-secret");
  vi.stubEnv("R2_HOSTED_SITES_BUCKET_NAME", "hosted");
  vi.stubEnv("R2_HOSTED_SITES_ACCESS_KEY_ID", "test-hosted-id");
  vi.stubEnv("R2_HOSTED_SITES_SECRET_ACCESS_KEY", "test-hosted-secret");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((directory) => {
      return rm(directory, { recursive: true, force: true });
    }),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "multipart-preflight-"));
  directories.push(directory);
  const reportPath = join(directory, "report.json");
  const uploads: MultipartUpload[] = [];
  const records = new Map<string, string>();
  const sender: {
    send(
      command: GetObjectCommand | ListMultipartUploadsCommand,
    ): Promise<unknown>;
  } = S3Client.prototype;
  const send = vi.spyOn(sender, "send").mockImplementation(async (command) => {
    if (command instanceof ListMultipartUploadsCommand) {
      if (
        command.input.Bucket !== "public" ||
        command.input.Prefix !== "artifacts/"
      )
        throw new Error("Unexpected multipart namespace");
      const offset = command.input.KeyMarker
        ? uploads.findIndex((upload) => {
            return (
              upload.Key === command.input.KeyMarker &&
              upload.UploadId === command.input.UploadIdMarker
            );
          }) + 1
        : 0;
      const upload = uploads[offset];
      const truncated = offset + 1 < uploads.length;
      return {
        Uploads: upload ? [upload] : [],
        IsTruncated: truncated,
        NextKeyMarker: truncated ? upload?.Key : undefined,
        NextUploadIdMarker: truncated ? upload?.UploadId : undefined,
      };
    }
    if (command instanceof GetObjectCommand) {
      if (command.input.Bucket !== "hosted" || !command.input.Key)
        throw new Error("Unexpected registration namespace");
      const body = records.get(command.input.Key);
      if (body === undefined)
        throw Object.assign(new Error("Missing registration"), {
          name: "NoSuchKey",
        });
      return {
        Body: {
          transformToString: async () => {
            return body;
          },
        },
      };
    }
    // The standalone command has no reason to read file bytes or write storage.
    throw new Error("Unexpected storage operation");
  });
  return { reportPath, uploads, records, send };
}

function registeredUpload(key: string) {
  return JSON.stringify({
    version: 1,
    kind: "legacy-file",
    audience: "public",
    publicBrand: "okou",
    key,
    filename: "private-user-filename.mp4",
    contentType: "video/mp4",
  });
}

test("blocked preflight writes aggregate initiation evidence without a database", async () => {
  const f = await fixture();
  f.uploads.push(
    {
      Key: "artifacts/newer.mp4",
      UploadId: "newer-secret-upload",
      Initiated: new Date("2026-09-09T12:00:00Z"),
    },
    {
      Key: "artifacts/older.mp4",
      UploadId: "older-secret-upload",
      Initiated: new Date("2026-09-08T12:00:00Z"),
    },
    { Key: "artifacts/unknown.mp4", UploadId: "unknown-secret-upload" },
    {
      Key: "artifacts/registered.mp4",
      UploadId: "registered-secret-upload",
      Initiated: new Date("2026-09-10T12:00:00Z"),
    },
  );
  f.records.set(
    "artifact-delivery/files/registered.mp4.json",
    registeredUpload("artifacts/registered.mp4"),
  );
  expect(
    await runMultipartPreflight([
      "--report",
      f.reportPath,
      "--concurrency",
      "2",
    ]),
  ).toBe(1);
  const body = await readFile(f.reportPath, "utf8");
  expect(JSON.parse(body)).toMatchObject({
    kind: "multipart-preflight",
    status: "blocked",
    startedAt: expect.any(String),
    completedAt: expect.any(String),
    pendingMultipartUploads: 4,
    unregisteredMultipartUploads: 3,
    oldestUnregisteredInitiatedAt: "2026-09-08T12:00:00.000Z",
    newestUnregisteredInitiatedAt: "2026-09-09T12:00:00.000Z",
    unregisteredWithUnknownInitiationTime: 1,
    verified: false,
    finalized: false,
  });
  for (const upload of f.uploads) {
    expect(body).not.toContain(upload.Key);
    expect(body).not.toContain(upload.UploadId);
  }
  expect(body).not.toContain("private-user-filename");
});

test.each([false, true])(
  "clear preflight permits full verification without claiming coverage (pending=%s)",
  async (pending) => {
    const f = await fixture();
    if (pending) {
      f.uploads.push(
        { Key: "artifacts/registered.mp4", UploadId: "upload-1" },
        { Key: "artifacts/registered.mp4", UploadId: "upload-2" },
      );
      f.records.set(
        "artifact-delivery/files/registered.mp4.json",
        registeredUpload("artifacts/registered.mp4"),
      );
    }
    expect(await runMultipartPreflight(["--report", f.reportPath])).toBe(0);
    expect(JSON.parse(await readFile(f.reportPath, "utf8"))).toMatchObject({
      status: "clear",
      pendingMultipartUploads: pending ? 2 : 0,
      unregisteredMultipartUploads: 0,
      oldestUnregisteredInitiatedAt: null,
      newestUnregisteredInitiatedAt: null,
      unregisteredWithUnknownInitiationTime: 0,
      verified: false,
      finalized: false,
    });
  },
);

test.each([
  registeredUpload("artifacts/wrong.mp4"),
  JSON.stringify({ kind: "publication", audience: "private" }),
  "malformed user metadata: sensitive filename",
])("invalid registration cannot clear the gate", async (record) => {
  const f = await fixture();
  f.uploads.push({ Key: "artifacts/test.mp4", UploadId: "upload-1" });
  f.records.set("artifact-delivery/files/test.mp4.json", record);
  await expect(
    runMultipartPreflight(["--report", f.reportPath]),
  ).rejects.toThrow(/registration.*invalid/);
  await expect(stat(f.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test("partial multipart listing cannot produce a clear report", async () => {
  const f = await fixture();
  f.send.mockResolvedValue({ Uploads: [], IsTruncated: true });
  await expect(
    runMultipartPreflight(["--report", f.reportPath]),
  ).rejects.toThrow("multipart upload pagination is incomplete");
  await expect(stat(f.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["--migrate", "--verify", "--finalize"])(
  "the standalone read-only parser rejects %s",
  async (flag) => {
    const f = await fixture();
    await expect(
      runMultipartPreflight([flag, "--report", f.reportPath]),
    ).rejects.toThrow("Unknown option");
    await expect(stat(f.reportPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
