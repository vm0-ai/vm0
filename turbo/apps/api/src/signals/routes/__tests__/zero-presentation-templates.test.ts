import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES,
  zeroPresentationTemplatesContract,
} from "@vm0/api-contracts/contracts/zero-presentation-templates";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import AdmZip from "adm-zip";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroPresentationTemplatesRoutes } from "../zero-presentation-templates";
import { zeroUploadsPrepareRoutes } from "../zero-uploads-prepare";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createZeroRouteMocks(context);
const ARTIFACT_BUCKET = "presentation-template-artifacts-test";
const STORAGE_BUCKET = "test-user-storages";
const PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  readonly lastModified: Date;
}

type Deferred = ReturnType<typeof createDeferredPromise<void>>;

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function objectId(bucket: string, key: string): string {
  return `${bucket}\0${key}`;
}

function notFoundError(key: string): Error {
  return Object.assign(new Error(`Missing S3 object: ${key}`), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}

function bodyBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body, "utf8");
  }
  throw new Error("Expected an S3 object body");
}

function rangeSlice(body: Buffer, range: unknown): Buffer {
  if (typeof range !== "string") {
    return body;
  }
  const match = /^bytes=(\d+)-(\d+)$/u.exec(range);
  if (!match) {
    throw new Error(`Unexpected byte range: ${range}`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  return body.subarray(start, end + 1);
}

function byteStream(body: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

function listStoredObjects(
  objects: ReadonlyMap<string, StoredObject>,
  bucket: string,
  prefix: string,
) {
  return [...objects.entries()].flatMap(([storedId, object]) => {
    const separator = storedId.indexOf("\0");
    const storedBucket = storedId.slice(0, separator);
    const storedKey = storedId.slice(separator + 1);
    return storedBucket === bucket && storedKey.startsWith(prefix)
      ? [
          {
            Key: storedKey,
            Size: object.body.length,
            LastModified: object.lastModified,
          },
        ]
      : [];
  });
}

function deleteStoredObjects(
  objects: Map<string, StoredObject>,
  bucket: string,
  deletion: unknown,
): void {
  if (typeof deletion !== "object" || deletion === null) {
    return;
  }
  const candidates = (deletion as { readonly Objects?: readonly unknown[] })
    .Objects;
  for (const candidate of candidates ?? []) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "Key" in candidate &&
      typeof candidate.Key === "string"
    ) {
      objects.delete(objectId(bucket, candidate.Key));
    }
  }
}

function installS3Fixture() {
  const objects = new Map<string, StoredObject>();
  let storagePutPause:
    | { readonly started: Deferred; readonly released: Deferred }
    | undefined;
  let deleteFailuresRemaining = 0;

  context.mocks.s3.send.mockImplementation(async (command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const key = typeof input.Key === "string" ? input.Key : "";
    const id = objectId(bucket, key);

    if (command instanceof PutObjectCommand) {
      if (bucket === STORAGE_BUCKET && storagePutPause) {
        if (!storagePutPause.started.settled()) {
          storagePutPause.started.resolve();
        }
        await storagePutPause.released.promise;
      }
      objects.set(id, {
        body: bodyBuffer(input.Body),
        contentType:
          typeof input.ContentType === "string" ? input.ContentType : undefined,
        metadata:
          typeof input.Metadata === "object" && input.Metadata !== null
            ? (input.Metadata as Readonly<Record<string, string>>)
            : {},
        lastModified: nowDate(),
      });
      return {};
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
      return {
        Contents: listStoredObjects(objects, bucket, prefix),
      };
    }
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(id);
      if (!object) {
        throw notFoundError(key);
      }
      return {
        ContentLength: object.body.length,
        ContentType: object.contentType,
        Metadata: object.metadata,
        LastModified: object.lastModified,
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(id);
      if (!object) {
        throw notFoundError(key);
      }
      const body = rangeSlice(object.body, input.Range);
      return {
        Body: byteStream(body),
        ContentLength: body.length,
        ContentType: object.contentType,
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      if (deleteFailuresRemaining > 0) {
        deleteFailuresRemaining -= 1;
        throw new Error("Injected R2 delete failure");
      }
      deleteStoredObjects(objects, bucket, input.Delete);
      return {};
    }
    return {};
  });
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://r2.example.test/presigned?signature=test",
  );

  return {
    objects,
    put(args: {
      readonly bucket: string;
      readonly key: string;
      readonly body: Buffer;
      readonly contentType: string;
      readonly metadata: Readonly<Record<string, string>>;
    }): void {
      objects.set(objectId(args.bucket, args.key), {
        body: args.body,
        contentType: args.contentType,
        metadata: args.metadata,
        lastModified: nowDate(),
      });
    },
    has(bucket: string, key: string): boolean {
      return objects.has(objectId(bucket, key));
    },
    keys(bucket: string): readonly string[] {
      return [...objects.keys()].flatMap((storedId) => {
        const separator = storedId.indexOf("\0");
        return storedId.slice(0, separator) === bucket
          ? [storedId.slice(separator + 1)]
          : [];
      });
    },
    failNextDelete(): void {
      deleteFailuresRemaining += 1;
    },
    pauseStoragePuts(): {
      readonly started: Promise<void>;
      readonly release: () => void;
    } {
      const started = createDeferredPromise<void>(context.signal);
      const released = createDeferredPromise<void>(context.signal);
      storagePutPause = { started, released };
      return {
        started: started.promise,
        release: () => {
          storagePutPause = undefined;
          released.resolve();
        },
      };
    },
  };
}

function metadataFromHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => {
      return [name.replace(/^x-amz-meta-/u, ""), value];
    }),
  );
}

function artifactKey(url: string): string {
  return new URL(url).pathname.replace(/^\//u, "");
}

function pptxSource(): Buffer {
  const archive = new AdmZip();
  archive.addFile(
    "ppt/presentation.xml",
    Buffer.from('<p:presentation xmlns:p="p"/>', "utf8"),
  );
  return archive.toBuffer();
}

function webHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function sandboxHeaders(actor: ApiTestUser, runId: string) {
  return {
    authorization: `Bearer ${runs.sandboxTokenForRun(actor, runId)}`,
  };
}

async function enablePresentationTemplates(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Presentation template tests require an organization");
  }
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.PresentationTemplates]: true,
    },
  );
}

async function prepareImportActor(
  actor: ApiTestUser,
  options: { readonly configureRunner?: boolean } = {},
): Promise<string> {
  await enablePresentationTemplates(actor);
  bdd.acceptAgentStorageWrites();
  await runs.grantProEntitlement(actor);
  const defaultAgentId = await bdd.bootstrapLimitedFreeOnboarding(actor, {
    displayName: "Presentation import agent",
  });
  await runs.ensureOrgModelProvider(actor);
  if (options.configureRunner !== false) {
    runs.configureRunnerGroup();
  }
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  return defaultAgentId;
}

async function importRunId(
  actor: ApiTestUser,
  templateId: string,
): Promise<string> {
  const listed = await runs.listAgentRuns(actor, { limit: 20 });
  const run = listed.runs.find((candidate) => {
    return candidate.prompt.startsWith(
      `Import presentation template ${templateId}.`,
    );
  });
  if (!run) {
    throw new Error(
      `Expected import run for presentation template ${templateId}`,
    );
  }
  return run.id;
}

function templateClient() {
  return setupApp({ context, routes: zeroPresentationTemplatesRoutes })(
    zeroPresentationTemplatesContract,
  );
}

function uploadClient() {
  return setupApp({ context, routes: zeroUploadsPrepareRoutes })(
    zeroUploadsContract,
  );
}

async function prepareSource(
  fixture: ReturnType<typeof installS3Fixture>,
  args: {
    readonly actor: ApiTestUser;
    readonly filename: string;
    readonly contentType: string;
    readonly body: Buffer;
  },
) {
  mocks.clerk.session(args.actor.userId, args.actor.orgId);
  const prepared = await accept(
    uploadClient().prepare({
      headers: webHeaders(),
      body: {
        filename: args.filename,
        contentType: args.contentType,
        size: args.body.length,
      },
    }),
    [200],
  );
  if (!("uploadHeaders" in prepared.body)) {
    throw new Error("Expected a single-part upload");
  }
  const key = artifactKey(prepared.body.url);
  fixture.put({
    bucket: ARTIFACT_BUCKET,
    key,
    body: args.body,
    contentType: args.contentType,
    metadata: metadataFromHeaders(prepared.body.uploadHeaders),
  });
  return { upload: prepared.body, key, body: args.body };
}

async function createTemplate(
  fixture: ReturnType<typeof installS3Fixture>,
  actor: ApiTestUser,
  filename: string,
) {
  const source = await prepareSource(fixture, {
    actor,
    filename,
    contentType: PPTX_CONTENT_TYPE,
    body: pptxSource(),
  });
  const created = await accept(
    templateClient().create({
      headers: webHeaders(),
      body: {
        uploadId: source.upload.id,
        filename: source.upload.filename,
        contentType: source.upload.contentType,
      },
    }),
    [201],
  );
  return { created: created.body, source };
}

beforeEach(() => {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", ARTIFACT_BUCKET);
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", STORAGE_BUCKET);
});

describe("presentation template imports", () => {
  it("keeps the catalog and template-import trigger source behind the feature switch", async () => {
    const actor = bdd.user();
    const fixture = installS3Fixture();
    const source = await prepareSource(fixture, {
      actor,
      filename: "disabled.pptx",
      contentType: PPTX_CONTENT_TYPE,
      body: pptxSource(),
    });
    const client = templateClient();

    await accept(client.list({ headers: webHeaders() }), [403]);
    await accept(
      client.create({
        headers: webHeaders(),
        body: {
          uploadId: source.upload.id,
          filename: source.upload.filename,
          contentType: source.upload.contentType,
        },
      }),
      [403],
    );
    expect((await runs.listAgentRuns(actor, { limit: 20 })).runs).toStrictEqual(
      [],
    );

    await enablePresentationTemplates(actor);
    const enabled = await accept(client.list({ headers: webHeaders() }), [200]);
    expect(enabled.body).toStrictEqual([]);
  });

  it("rejects PDF and HTML before creating a template", async () => {
    const actor = bdd.user();
    await enablePresentationTemplates(actor);
    const fixture = installS3Fixture();
    const unsupportedSources = [
      {
        filename: "deck.pdf",
        contentType: "application/pdf",
        body: Buffer.from("%PDF-1.7\n%%EOF"),
      },
      {
        filename: "deck.html",
        contentType: "text/html",
        body: Buffer.from("<!doctype html><title>Deck</title>"),
      },
    ];
    const errorCodes: string[] = [];
    for (const unsupported of unsupportedSources) {
      const source = await prepareSource(fixture, { actor, ...unsupported });
      const response = await accept(
        templateClient().create({
          headers: webHeaders(),
          body: {
            uploadId: source.upload.id,
            filename: source.upload.filename,
            contentType: source.upload.contentType,
          },
        }),
        [400],
      );
      errorCodes.push(response.body.error.code);
    }
    expect(errorCodes).toStrictEqual([
      "unsupported_format",
      "unsupported_format",
    ]);

    const listed = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(listed.body).toStrictEqual([]);
  });

  it("enforces owner and import-run scope and rejects a second active import", async () => {
    const owner = bdd.user();
    const ownerAgentId = await prepareImportActor(owner);
    const fixture = installS3Fixture();
    const { created } = await createTemplate(
      fixture,
      owner,
      "owner-template.pptx",
    );
    const ownerRunId = await importRunId(owner, created.id);

    const secondSource = await prepareSource(fixture, {
      actor: owner,
      filename: "second-template.pptx",
      contentType: PPTX_CONTENT_TYPE,
      body: pptxSource(),
    });
    await accept(
      templateClient().create({
        headers: webHeaders(),
        body: {
          uploadId: secondSource.upload.id,
          filename: secondSource.upload.filename,
          contentType: secondSource.upload.contentType,
        },
      }),
      [409],
    );

    const peer = bdd.user({ orgId: owner.orgId });
    await enablePresentationTemplates(peer);
    const peerList = await accept(
      templateClient().list({ headers: webHeaders() }),
      [200],
    );
    expect(peerList.body).toStrictEqual([]);
    await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: created.id },
      }),
      [404],
    );

    const otherOrg = bdd.user({ userId: owner.userId });
    await enablePresentationTemplates(otherOrg);
    await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: created.id },
      }),
      [404],
    );

    const unrelatedRun = await runs.createDirectRun(owner, {
      agentComposeId: ownerAgentId,
      prompt: "Unrelated owner run",
      triggerSource: "test",
      vars: { ZERO_AGENT_ID: ownerAgentId },
      secrets: { ZERO_TOKEN: "unrelated-test-token" },
    });

    const wrongRunHeaders = [
      sandboxHeaders(peer, ownerRunId),
      sandboxHeaders(otherOrg, ownerRunId),
      sandboxHeaders(owner, unrelatedRun.runId),
    ];
    for (const headers of wrongRunHeaders) {
      await accept(
        templateClient().source({
          headers,
          params: { templateId: created.id },
        }),
        [404],
      );
      await accept(
        templateClient().preparePages({
          headers,
          params: { templateId: created.id },
          body: { count: 1 },
        }),
        [404],
      );
      await accept(
        templateClient().commitPages({
          headers,
          params: { templateId: created.id },
          body: { keys: ["not-the-import-page.png"], aspectRatio: 16 / 9 },
        }),
        [404],
      );
      await accept(
        templateClient().publishPackage({
          headers,
          params: { templateId: created.id },
          body: {
            files: [
              { path: "DESIGN_SYSTEM.md", content: "# Design" },
              { path: "LAYOUTS.md", content: "# Layouts" },
              { path: "tokens.json", content: "{}" },
            ],
          },
        }),
        [404],
      );
      await accept(
        templateClient().fail({
          headers,
          params: { templateId: created.id },
          body: { code: "analysis_failed", message: "wrong run" },
        }),
        [404],
      );
    }
  });

  it("creates, compiles, renames, reads, and deletes an owned template", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);

    const fixture = installS3Fixture();
    const source = await prepareSource(fixture, {
      actor,
      filename: "brand-system.pptx",
      contentType: PPTX_CONTENT_TYPE,
      body: pptxSource(),
    });
    const client = templateClient();
    const created = await accept(
      client.create({
        headers: webHeaders(),
        body: {
          uploadId: source.upload.id,
          filename: source.upload.filename,
          contentType: source.upload.contentType,
        },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      title: "brand-system",
      status: "pending",
      pageCount: 0,
      coverUrl: null,
    });

    const runId = await importRunId(actor, created.body.id);
    const runHeaders = sandboxHeaders(actor, runId);
    const sourceDownload = await accept(
      client.source({
        headers: runHeaders,
        params: { templateId: created.body.id },
      }),
      [200],
    );
    expect(sourceDownload.body).toMatchObject({
      filename: "brand-system.pptx",
      contentType: PPTX_CONTENT_TYPE,
      size: source.body.length,
    });

    const preparedPages = await accept(
      client.preparePages({
        headers: runHeaders,
        params: { templateId: created.body.id },
        body: { count: 2 },
      }),
      [200],
    );
    for (const [index, upload] of preparedPages.body.uploads.entries()) {
      fixture.put({
        bucket: ARTIFACT_BUCKET,
        key: upload.key,
        body: Buffer.from(`png-${index.toString()}`),
        contentType: "image/png",
        metadata: metadataFromHeaders(upload.uploadHeaders),
      });
    }

    const committed = await accept(
      client.commitPages({
        headers: runHeaders,
        params: { templateId: created.body.id },
        body: {
          keys: preparedPages.body.uploads.map((upload) => {
            return upload.key;
          }),
          aspectRatio: 16 / 9,
        },
      }),
      [200],
    );
    expect(committed.body.status).toBe("processing");

    const oversizedUtf8Package = await accept(
      client.publishPackage({
        headers: runHeaders,
        params: { templateId: created.body.id },
        body: {
          files: [
            {
              path: "DESIGN_SYSTEM.md",
              content: "é".repeat(
                Math.floor(MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES / 2) +
                  1,
              ),
            },
            { path: "LAYOUTS.md", content: "# Layouts" },
            { path: "tokens.json", content: '{"colors":{}}' },
          ],
        },
      }),
      [400],
    );
    expect(oversizedUtf8Package.body.error.code).toBe("BAD_REQUEST");

    const storageKeysBeforePublish = new Set(fixture.keys(STORAGE_BUCKET));
    const published = await accept(
      client.publishPackage({
        headers: runHeaders,
        params: { templateId: created.body.id },
        body: {
          files: [
            { path: "DESIGN_SYSTEM.md", content: "# Design system" },
            { path: "LAYOUTS.md", content: "# Layouts" },
            { path: "tokens.json", content: '{"colors":{}}' },
          ],
        },
      }),
      [200],
    );
    expect(published.body.status).toBe("ready");
    const packageKeys = fixture.keys(STORAGE_BUCKET).filter((key) => {
      return !storageKeysBeforePublish.has(key);
    });
    expect(packageKeys.length).toBeGreaterThan(0);

    mocks.clerk.session(actor.userId, actor.orgId);
    const renamed = await accept(
      client.update({
        headers: webHeaders(),
        params: { templateId: created.body.id },
        body: { title: "Renamed template" },
      }),
      [200],
    );
    expect(renamed.body).toMatchObject({
      title: "Renamed template",
      status: "ready",
      pageCount: 2,
    });

    const detail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: created.body.id },
      }),
      [200],
    );
    expect(detail.body.pageUrls).toHaveLength(2);
    expect(detail.body.coverUrl).toBe(detail.body.pageUrls[0]);

    await accept(
      client.delete({
        headers: webHeaders(),
        params: { templateId: created.body.id },
      }),
      [204],
    );
    expect(fixture.has(ARTIFACT_BUCKET, source.key)).toBeTruthy();
    for (const upload of preparedPages.body.uploads) {
      expect(fixture.has(ARTIFACT_BUCKET, upload.key)).toBeFalsy();
    }
    for (const key of packageKeys) {
      expect(fixture.has(STORAGE_BUCKET, key)).toBeFalsy();
    }
    const missing = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: created.body.id },
      }),
      [404],
    );
    expect(missing.body.error.code).toBe("NOT_FOUND");

    const failedSource = await prepareSource(fixture, {
      actor,
      filename: "broken.pptx",
      contentType: PPTX_CONTENT_TYPE,
      body: pptxSource(),
    });
    const failedTemplate = await accept(
      client.create({
        headers: webHeaders(),
        body: {
          uploadId: failedSource.upload.id,
          filename: failedSource.upload.filename,
          contentType: failedSource.upload.contentType,
        },
      }),
      [201],
    );
    const failedRunId = await importRunId(actor, failedTemplate.body.id);
    const failed = await accept(
      client.fail({
        headers: sandboxHeaders(actor, failedRunId),
        params: { templateId: failedTemplate.body.id },
        body: { code: "render_failed", message: "Renderer exited with 1" },
      }),
      [200],
    );
    expect(failed.body.status).toBe("failed");

    mocks.clerk.session(actor.userId, actor.orgId);
    const failedDetail = await accept(
      client.get({
        headers: webHeaders(),
        params: { templateId: failedTemplate.body.id },
      }),
      [200],
    );
    expect(failedDetail.body).toMatchObject({
      status: "failed",
      error: { code: "render_failed", message: "Renderer exited with 1" },
    });
    await accept(
      client.delete({
        headers: webHeaders(),
        params: { templateId: failedTemplate.body.id },
      }),
      [204],
    );
  });

  it("terminalizes an import when run dispatch fails immediately", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor, { configureRunner: false });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);
    const fixture = installS3Fixture();

    const first = await createTemplate(fixture, actor, "dispatch-fails.pptx");
    expect(first.created).toMatchObject({ status: "failed", pageCount: 0 });

    const second = await createTemplate(
      fixture,
      actor,
      "dispatch-fails-again.pptx",
    );
    expect(second.created).toMatchObject({ status: "failed", pageCount: 0 });
  });

  it("cleans prepared pages when the import run fails automatically", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const { created } = await createTemplate(
      fixture,
      actor,
      "terminal-failure.pptx",
    );
    const runId = await importRunId(actor, created.id);
    const runHeaders = sandboxHeaders(actor, runId);
    const prepared = await accept(
      templateClient().preparePages({
        headers: runHeaders,
        params: { templateId: created.id },
        body: { count: 1 },
      }),
      [200],
    );
    const upload = prepared.body.uploads[0];
    if (!upload) {
      throw new Error("Expected a prepared page upload");
    }
    fixture.put({
      bucket: ARTIFACT_BUCKET,
      key: upload.key,
      body: Buffer.from("prepared-page"),
      contentType: "image/png",
      metadata: metadataFromHeaders(upload.uploadHeaders),
    });

    await webhooks.requestAgentComplete(
      { runId, exitCode: 1, error: "renderer crashed" },
      runHeaders,
      [200],
    );
    await flushWaitUntilForTest();

    expect(fixture.has(ARTIFACT_BUCKET, upload.key)).toBeFalsy();
    mocks.clerk.session(actor.userId, actor.orgId);
    const detail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: created.id },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      status: "failed",
      pageCount: 0,
      error: { code: "analysis_failed", message: "renderer crashed" },
    });
  });

  it("keeps deletion retryable for a prepared but uncommitted page", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const { created } = await createTemplate(
      fixture,
      actor,
      "delete-prepared.pptx",
    );
    const runId = await importRunId(actor, created.id);
    const prepared = await accept(
      templateClient().preparePages({
        headers: sandboxHeaders(actor, runId),
        params: { templateId: created.id },
        body: { count: 1 },
      }),
      [200],
    );
    const upload = prepared.body.uploads[0];
    if (!upload) {
      throw new Error("Expected a prepared page upload");
    }
    fixture.put({
      bucket: ARTIFACT_BUCKET,
      key: upload.key,
      body: Buffer.from("prepared-page"),
      contentType: "image/png",
      metadata: metadataFromHeaders(upload.uploadHeaders),
    });

    mocks.clerk.session(actor.userId, actor.orgId);
    fixture.failNextDelete();
    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId: created.id },
      }),
      [500],
    );
    expect(fixture.has(ARTIFACT_BUCKET, upload.key)).toBeTruthy();
    await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: created.id },
      }),
      [200],
    );

    await accept(
      templateClient().delete({
        headers: webHeaders(),
        params: { templateId: created.id },
      }),
      [204],
    );
    expect(fixture.has(ARTIFACT_BUCKET, upload.key)).toBeFalsy();

    fixture.put({
      bucket: ARTIFACT_BUCKET,
      key: upload.key,
      body: Buffer.from("late-prepared-page"),
      contentType: "image/png",
      metadata: metadataFromHeaders(upload.uploadHeaders),
    });
    await webhooks.requestAgentComplete(
      { runId, exitCode: 1, error: "cancelled after deletion" },
      sandboxHeaders(actor, runId),
      [200],
    );
    await flushWaitUntilForTest();
    expect(fixture.has(ARTIFACT_BUCKET, upload.key)).toBeFalsy();
  });

  it("compensates package objects when failure wins the publication race", async () => {
    const actor = bdd.user();
    await prepareImportActor(actor);
    const fixture = installS3Fixture();
    const { created } = await createTemplate(
      fixture,
      actor,
      "publish-race.pptx",
    );
    const runId = await importRunId(actor, created.id);
    const runHeaders = sandboxHeaders(actor, runId);
    const prepared = await accept(
      templateClient().preparePages({
        headers: runHeaders,
        params: { templateId: created.id },
        body: { count: 1 },
      }),
      [200],
    );
    const upload = prepared.body.uploads[0];
    if (!upload) {
      throw new Error("Expected a prepared page upload");
    }
    fixture.put({
      bucket: ARTIFACT_BUCKET,
      key: upload.key,
      body: Buffer.from("page"),
      contentType: "image/png",
      metadata: metadataFromHeaders(upload.uploadHeaders),
    });
    await accept(
      templateClient().commitPages({
        headers: runHeaders,
        params: { templateId: created.id },
        body: { keys: [upload.key], aspectRatio: 16 / 9 },
      }),
      [200],
    );

    const pause = fixture.pauseStoragePuts();
    const publication = accept(
      templateClient().publishPackage({
        headers: runHeaders,
        params: { templateId: created.id },
        body: {
          files: [
            { path: "DESIGN_SYSTEM.md", content: "# Design" },
            { path: "LAYOUTS.md", content: "# Layouts" },
            { path: "tokens.json", content: "{}" },
          ],
        },
      }),
      [409],
    );
    await pause.started;
    const failure = accept(
      templateClient().fail({
        headers: runHeaders,
        params: { templateId: created.id },
        body: { code: "publish_failed", message: "publication cancelled" },
      }),
      [200],
    );
    await expect
      .poll(async () => {
        mocks.clerk.session(actor.userId, actor.orgId);
        const detail = await accept(
          templateClient().get({
            headers: webHeaders(),
            params: { templateId: created.id },
          }),
          [200],
        );
        return detail.body.status;
      })
      .toBe("failed");
    pause.release();
    await Promise.all([failure, publication]);

    expect(fixture.keys(STORAGE_BUCKET)).toStrictEqual([]);
    mocks.clerk.session(actor.userId, actor.orgId);
    const detail = await accept(
      templateClient().get({
        headers: webHeaders(),
        params: { templateId: created.id },
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      status: "failed",
      pageCount: 0,
      error: { code: "publish_failed", message: "publication cancelled" },
    });
  });
});
