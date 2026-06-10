import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";

// BDD migration of the legacy `zero-web-download.test.ts`.
// The 11 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth + 400 + 404 chain (401 no auth → 403 no `file:read`
// capability → 400 missing file_id → 400 empty file_id → 404
// file not in S3), (2) 200 happy-path chain (200 downloads
// a text file with matching headers → 200 encodes the
// filename header while preserving the binary body → 200
// downloads an image file with the image MIME type → 200
// downloads an office file with the office MIME type → 200
// returns application/octet-stream for unknown extensions
// → 200 scopes file lookup to the authenticated user via
// the S3 prefix).

const context = testContext();
const store = createStore();
const trackOrgMembership = createFixtureTracker<OrgMembershipFixture>(
  (fixture) => {
    return store.set(deleteOrgMembership$, fixture, context.signal);
  },
);
const BUCKET = "test-user-artifacts";
const ROUTE = "/api/zero/web/download-file";

interface S3FixtureObject {
  readonly key: string;
  readonly size: number;
  readonly body: Buffer;
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function mintZeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: args.capabilities,
    iat: seconds,
    exp: seconds + 3600,
  });
}

async function mintFileReadToken(): Promise<{
  readonly orgId: string;
  readonly token: string;
  readonly userId: string;
}> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await trackOrgMembership(
    store.set(
      seedOrgMembership$,
      { orgId, userId, seedOrgCache: false },
      context.signal,
    ),
  );
  return {
    orgId,
    userId,
    token: mintZeroToken({
      userId,
      orgId,
      capabilities: ["file:read"],
    }),
  };
}

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

function bodyStream(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* stream(): AsyncIterable<Uint8Array> {
    yield buffer;
  })();
}

function mockS3Objects(objects: readonly S3FixtureObject[]): void {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", BUCKET);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : undefined;
    const key = typeof input.Key === "string" ? input.Key : undefined;

    if (prefix !== undefined) {
      return Promise.resolve({
        Contents: objects
          .filter((object) => {
            return object.key.startsWith(prefix) && bucket === BUCKET;
          })
          .map((object) => {
            return {
              Key: object.key,
              Size: object.size,
              LastModified: new Date("2025-01-01T00:00:00.000Z"),
            };
          }),
      });
    }

    if (key !== undefined) {
      const object = objects.find((candidate) => {
        return candidate.key === key && bucket === BUCKET;
      });
      return Promise.resolve({
        Body: object ? bodyStream(object.body) : bodyStream(Buffer.alloc(0)),
      });
    }

    return Promise.resolve({});
  });
}

function requestDownload(args: {
  readonly fileId?: string;
  readonly token?: string;
}): Promise<Response> {
  const search =
    args.fileId === undefined
      ? ""
      : `?file_id=${encodeURIComponent(args.fileId)}`;
  const headers: Record<string, string> = args.token
    ? { authorization: `Bearer ${args.token}` }
    : {};
  const app = createApp({ signal: context.signal });
  return Promise.resolve(
    app.request(`${ROUTE}${search}`, { method: "GET", headers }),
  );
}

function artifactKey(userId: string, fileId: string, filename: string): string {
  return `artifacts/${userId}/${fileId}/${filename}`;
}

async function expectErrorResponse(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    readonly error?: { readonly code?: string };
  };
  expect(body.error?.code).toBe(code);
}

describe("BDD GET /api/zero/web/download-file — auth + 400 + 404 chain", () => {
  it("gwt-wt-wt: 401 no auth → 403 no file:read capability → 400 missing file_id → 400 empty file_id → 404 file not in S3", async () => {
    // When + Then: 401 — no auth header.
    const noAuth = await requestDownload({ fileId: "abc" });
    await expectErrorResponse(noAuth, 401, "UNAUTHORIZED");

    // Given: a zero token without `file:read` capability.
    const noCapToken = mintZeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["agent:read"],
    });

    // When + Then: 403.
    const noCap = await requestDownload({ fileId: "abc", token: noCapToken });
    await expectErrorResponse(noCap, 403, "FORBIDDEN");

    // Given: a fresh file:read token.
    const missing = await mintFileReadToken();

    // When + Then: 400 — file_id query param is missing.
    const noFileId = await requestDownload({ token: missing.token });
    await expectErrorResponse(noFileId, 400, "BAD_REQUEST");

    // Given: a fresh file:read token.
    const empty = await mintFileReadToken();

    // When + Then: 400 — file_id query param is empty.
    const emptyFileId = await requestDownload({
      fileId: "",
      token: empty.token,
    });
    await expectErrorResponse(emptyFileId, 400, "BAD_REQUEST");

    // Given: a fresh file:read token + an empty S3 bucket.
    const missingFile = await mintFileReadToken();
    mockS3Objects([]);

    // When + Then: 404 — file not found in S3.
    const notFound = await requestDownload({
      fileId: "missing",
      token: missingFile.token,
    });
    await expectErrorResponse(notFound, 404, "NOT_FOUND");
  });
});

describe("BDD GET /api/zero/web/download-file — 200 happy-path chain", () => {
  it("gwt-wt-wt: 200 downloads a text file with matching headers → 200 encodes the filename header while preserving the binary body → 200 downloads an image file with the image MIME type → 200 downloads an office file with the office MIME type → 200 returns application/octet-stream for unknown extensions → 200 scopes file lookup to the authenticated user", async () => {
    // Given: a text file in S3.
    const textFileId = "test-file-uuid";
    const textContent = Buffer.from("hello world");
    const textFx = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(textFx.userId, textFileId, "test_file.txt"),
        size: textContent.length,
        body: textContent,
      },
    ]);

    // When + Then: 200 — text file downloads with the
    // matching headers + body matches the fixture.
    const textResponse = await requestDownload({
      fileId: textFileId,
      token: textFx.token,
    });
    expect(textResponse.status).toBe(200);
    expect(textResponse.headers.get("content-type")).toBe("text/plain");
    expect(textResponse.headers.get("x-file-name")).toBe("test_file.txt");
    expect(textResponse.headers.get("x-file-mimetype")).toBe("text/plain");
    expect(textResponse.headers.get("content-length")).toBe(
      String(textContent.length),
    );
    const textReceived = Buffer.from(await textResponse.arrayBuffer());
    expect(textReceived.equals(textContent)).toBeTruthy();

    // Given: a file with an encoded filename + binary body.
    const encodedFileId = "encoded-name-uuid";
    const encodedContent = Buffer.from([0, 1, 2, 3, 255]);
    const encodedFx = await mintFileReadToken();
    const encodedFilename = "report 2026 #final.bin";
    mockS3Objects([
      {
        key: artifactKey(encodedFx.userId, encodedFileId, encodedFilename),
        size: encodedContent.length,
        body: encodedContent,
      },
    ]);

    // When + Then: 200 — the x-file-name header is
    // URL-encoded while the body is the raw binary.
    const encodedResponse = await requestDownload({
      fileId: encodedFileId,
      token: encodedFx.token,
    });
    expect(encodedResponse.status).toBe(200);
    expect(encodedResponse.headers.get("x-file-name")).toBe(
      encodeURIComponent(encodedFilename),
    );
    expect(encodedResponse.headers.get("content-length")).toBe(
      String(encodedContent.length),
    );
    const encodedReceived = Buffer.from(await encodedResponse.arrayBuffer());
    expect(encodedReceived.equals(encodedContent)).toBeTruthy();

    // Given: a PNG image in S3.
    const imageFileId = "img-uuid";
    const imageContent = Buffer.from("fake-png-data");
    const imageFx = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(imageFx.userId, imageFileId, "photo.png"),
        size: imageContent.length,
        body: imageContent,
      },
    ]);

    // When + Then: 200 — image file downloads with the
    // `image/png` MIME type.
    const imageResponse = await requestDownload({
      fileId: imageFileId,
      token: imageFx.token,
    });
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("x-file-mimetype")).toBe("image/png");

    // Given: an xlsx office file in S3.
    const officeFileId = "sheet-uuid";
    const officeContent = Buffer.from("fake-xlsx-data");
    const officeFx = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(officeFx.userId, officeFileId, "budget.xlsx"),
        size: officeContent.length,
        body: officeContent,
      },
    ]);

    // When + Then: 200 — office file downloads with the
    // expected office MIME type.
    const officeExpected =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const officeResponse = await requestDownload({
      fileId: officeFileId,
      token: officeFx.token,
    });
    expect(officeResponse.status).toBe(200);
    expect(officeResponse.headers.get("content-type")).toBe(officeExpected);
    expect(officeResponse.headers.get("x-file-mimetype")).toBe(officeExpected);

    // Given: a file with an unknown extension.
    const binFileId = "bin-uuid";
    const binContent = Buffer.from("binary-data");
    const binFx = await mintFileReadToken();
    mockS3Objects([
      {
        key: artifactKey(binFx.userId, binFileId, "data.xyz"),
        size: binContent.length,
        body: binContent,
      },
    ]);

    // When + Then: 200 — application/octet-stream MIME type.
    const binResponse = await requestDownload({
      fileId: binFileId,
      token: binFx.token,
    });
    expect(binResponse.status).toBe(200);
    expect(binResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );

    // Given: a fresh token + an empty S3 mock so the file
    // lookup prefix is the only S3 call.
    const scopedFileId = "scoped-uuid";
    const scopedFx = await mintFileReadToken();
    context.mocks.s3.send.mockClear();
    mockS3Objects([]);

    await requestDownload({ fileId: scopedFileId, token: scopedFx.token });

    // Then: the S3 call scoped the file lookup to the
    // authenticated user.
    const prefixes = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command).Prefix;
      })
      .filter((prefix): prefix is string => {
        return typeof prefix === "string";
      });
    expect(prefixes).toContain(`artifacts/${scopedFx.userId}/${scopedFileId}/`);
  });
});
