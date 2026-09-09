import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { expect, test, vi } from "vitest";
import {
  artifactDeliveryKey,
  artifactDeliveryRegistrationKey,
} from "@okouai/api-contracts/contracts/artifact-delivery";
import { registerHistoricalPublicArtifacts } from "./backfill";

function fixture() {
  const client = new S3Client({
    region: "auto",
    credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
  });
  const objects = new Map<string, string>();
  const metadata = new Map<string, Record<string, string>>();
  const writes: string[] = [];
  const id = "00000000-0000-4000-8000-000000000001";
  const prefix = `sites/demo/deployments/${id}`;
  objects.set("public/artifacts/0123456789.pdf", "historical bytes");
  objects.set(
    `hosted/${prefix}/manifest.json`,
    JSON.stringify({
      version: 1,
      deploymentId: id,
      siteId: "site",
      publicSlug: "demo",
      files: {},
    }),
  );
  const pointer = JSON.stringify({
    version: 1,
    deploymentId: id,
    siteId: "site",
    publicSlug: "demo",
    prefix,
    manifestKey: `${prefix}/manifest.json`,
  });
  objects.set("hosted/sites/demo/active.json", pointer);
  objects.set(`hosted/sites/deployments/${id}.json`, pointer);
  const sender: {
    send(
      command:
        | GetObjectCommand
        | HeadObjectCommand
        | ListObjectsV2Command
        | PutObjectCommand,
    ): Promise<unknown>;
  } = client;
  const send = vi.spyOn(sender, "send").mockImplementation(async (command) => {
    if (command instanceof ListObjectsV2Command) {
      const root = `${command.input.Bucket}/`;
      const keys = [...objects.keys()]
        .filter((key) => {
          return key.startsWith(`${root}${command.input.Prefix}`);
        })
        .sort();
      const offset = Number(command.input.ContinuationToken ?? "0");
      // Multiple pages make truncation and reconciliation observable.
      return {
        Contents: keys.slice(offset, offset + 1).map((Key) => {
          return { Key: Key.slice(root.length) };
        }),
        IsTruncated: offset + 1 < keys.length,
        NextContinuationToken:
          offset + 1 < keys.length ? String(offset + 1) : undefined,
      };
    }
    if (command instanceof HeadObjectCommand)
      return {
        ContentType: "application/pdf",
        Metadata: metadata.get(command.input.Key!) ?? {},
      };
    if (command instanceof GetObjectCommand) {
      const body = objects.get(`${command.input.Bucket}/${command.input.Key}`);
      if (body === undefined)
        throw Object.assign(new Error("Missing"), { name: "NoSuchKey" });
      return {
        Body: {
          transformToString: async () => {
            return body;
          },
        },
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = `${command.input.Bucket}/${command.input.Key}`;
      if (command.input.IfNoneMatch === "*" && objects.has(key))
        throw Object.assign(new Error("Conflict"), {
          name: "PreconditionFailed",
        });
      writes.push(key);
      objects.set(key, String(command.input.Body));
      return {};
    }
    throw new Error("Unexpected storage request");
  });
  const options = {
    publicBucket: "public",
    hostedBucket: "hosted",
    migrate: false,
    verify: false,
    finalize: false,
    maxObjects: 100,
  };
  const reconcile = vi.fn(
    async (files: ReadonlySet<string>, deployments: ReadonlySet<string>) => {
      expect([...files]).toStrictEqual(["artifacts/0123456789.pdf"]);
      expect([...deployments]).toStrictEqual([id]);
    },
  );
  return { client, objects, metadata, writes, options, reconcile, send };
}

test("dry-run inventories all pages and reconciles twice without writing", async () => {
  const f = fixture();
  const result = await registerHistoricalPublicArtifacts(
    f.client,
    f.client,
    f.options,
    f.reconcile,
  );
  expect(result).toMatchObject({
    files: 1,
    deployments: 1,
    aliases: 3,
    missing: 3,
    registered: 0,
    finalized: false,
  });
  expect(f.writes).toStrictEqual([]);
  expect(f.reconcile).toHaveBeenCalledTimes(2);
});

test("registration is idempotent, verifies exact metadata, and preserves bytes and pointers", async () => {
  const f = fixture();
  const original = new Map(f.objects);
  const options = { ...f.options, migrate: true };
  const first = await registerHistoricalPublicArtifacts(
    f.client,
    f.client,
    options,
    f.reconcile,
  );
  expect(first.registered).toBe(3);
  expect(first.verified).toBe(true);
  for (const [key, body] of original) expect(f.objects.get(key)).toBe(body);
  expect(
    f.writes.every((key) => {
      return key.startsWith("hosted/artifact-delivery/");
    }),
  ).toBe(true);
  const second = await registerHistoricalPublicArtifacts(
    f.client,
    f.client,
    { ...options, verify: true, finalize: true },
    f.reconcile,
  );
  expect(second).toMatchObject({ existing: 3, registered: 0, finalized: true });
  for (const brand of ["vm0", "okou"] as const) {
    expect(
      JSON.parse(
        f.objects.get(`hosted/${artifactDeliveryRegistrationKey(brand)}`)!,
      ),
    ).toMatchObject({
      version: 1,
      complete: true,
      inventoryHash: first.inventoryHash,
    });
  }
});

test("private metadata or conflicting registrations are never made public", async () => {
  const f = fixture();
  f.metadata.set("artifacts/0123456789.pdf", {
    storage: "private-artifact-v1",
  });
  await expect(
    registerHistoricalPublicArtifacts(
      f.client,
      f.client,
      { ...f.options, migrate: true },
      f.reconcile,
    ),
  ).rejects.toThrow("Private metadata");
  expect(f.writes).toHaveLength(0);
  f.metadata.clear();
  f.objects.set(
    `hosted/${artifactDeliveryKey("vm0", "file", "0123456789.pdf")}`,
    JSON.stringify({
      version: 1,
      kind: "legacy-file",
      publicBrand: "vm0",
      audience: "public",
      key: "artifacts/another.pdf",
      filename: "another.pdf",
      contentType: "application/pdf",
    }),
  );
  f.objects.set(
    `hosted/${artifactDeliveryKey("vm0", "html", "demo")}`,
    JSON.stringify({ kind: "publication", audience: "private" }),
  );
  await expect(
    registerHistoricalPublicArtifacts(
      f.client,
      f.client,
      { ...f.options, migrate: true },
      f.reconcile,
    ),
  ).rejects.toMatchObject({
    message: expect.stringContaining("2 conflicts"),
    report: {
      status: "blocked",
      files: 1,
      deployments: 1,
      aliases: 3,
      conflicts: expect.arrayContaining([
        artifactDeliveryKey("vm0", "file", "0123456789.pdf"),
        artifactDeliveryKey("vm0", "html", "demo"),
      ]),
    },
  });
  expect(f.writes).toHaveLength(0);
});

test("bounds and unclassified keys prevent a completion marker", async () => {
  const f = fixture();
  await expect(
    registerHistoricalPublicArtifacts(
      f.client,
      f.client,
      { ...f.options, maxObjects: 1 },
      f.reconcile,
    ),
  ).rejects.toThrow("Inventory limit");
  f.objects.set("public/artifacts/unclassified", "unknown");
  await expect(
    registerHistoricalPublicArtifacts(
      f.client,
      f.client,
      { ...f.options, migrate: true, verify: true, finalize: true },
      f.reconcile,
    ),
  ).rejects.toThrow("Unclassified");
  expect(
    f.writes.some((key) => {
      return key.endsWith("registration.json");
    }),
  ).toBe(false);
});
