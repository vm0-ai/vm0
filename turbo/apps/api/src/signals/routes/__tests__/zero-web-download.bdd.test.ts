import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";

const context = testContext();

const BUCKET = "test-user-artifacts";
const ROUTE = "/api/zero/web/download-file";

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

interface FileReadToken extends Actor {
  readonly token: string;
}

interface S3FixtureObject {
  readonly body: Buffer;
  readonly key: string;
  readonly size: number;
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    orgId: `org_${prefix}_${suffix}`,
    userId: `user_${prefix}_${suffix}`,
  };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function mockClerkMembership(member: Actor): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: member.orgId }, role: "org:member" }],
  });
}

function mintZeroToken(args: {
  readonly capabilities: readonly ZeroCapability[];
  readonly orgId: string;
  readonly userId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 3600,
  });
}

function mintFileReadToken(prefix: string): FileReadToken {
  const member = actor(prefix);
  mockClerkMembership(member);
  return {
    ...member,
    token: mintZeroToken({
      userId: member.userId,
      orgId: member.orgId,
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

function mockPaginatedS3Object(object: S3FixtureObject): void {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", BUCKET);
  let listCalls = 0;
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : undefined;
    const key = typeof input.Key === "string" ? input.Key : undefined;

    if (prefix !== undefined) {
      listCalls += 1;
      if (listCalls === 1) {
        return Promise.resolve({
          Contents: [
            { Key: `${prefix}missing-size.txt` },
            { Size: 1, LastModified: new Date("2025-01-01T00:00:00.000Z") },
          ],
          NextContinuationToken: "next-page",
        });
      }

      return Promise.resolve({
        Contents:
          bucket === BUCKET && object.key.startsWith(prefix)
            ? [
                {
                  Key: object.key,
                  Size: object.size,
                  LastModified: new Date("2025-01-01T00:00:00.000Z"),
                },
              ]
            : [],
      });
    }

    if (key === object.key && bucket === BUCKET) {
      return Promise.resolve({ Body: bodyStream(object.body) });
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
  const headers: Record<string, string> =
    args.token === undefined ? {} : { authorization: `Bearer ${args.token}` };
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

async function expectDownloadedBody(
  response: Response,
  expected: Buffer,
): Promise<void> {
  const receivedBytes = Buffer.from(await response.arrayBuffer());
  expect(receivedBytes.equals(expected)).toBeTruthy();
}

describe("/api/zero/web/download-file BDD", () => {
  it("requires file:read zero-token auth and a non-empty file_id", async () => {
    const unauthenticated = await requestDownload({ fileId: "abc" });

    await expectErrorResponse(unauthenticated, 401, "UNAUTHORIZED");

    const member = actor("download_forbidden");
    const forbiddenToken = mintZeroToken({
      userId: member.userId,
      orgId: member.orgId,
      capabilities: ["agent:read"],
    });
    const forbidden = await requestDownload({
      fileId: "abc",
      token: forbiddenToken,
    });

    await expectErrorResponse(forbidden, 403, "FORBIDDEN");

    const { token } = mintFileReadToken("download_query");
    const missingFileId = await requestDownload({ token });
    const emptyFileId = await requestDownload({ fileId: "", token });

    await expectErrorResponse(missingFileId, 400, "BAD_REQUEST");
    await expectErrorResponse(emptyFileId, 400, "BAD_REQUEST");
  });

  it("returns 404 for missing files while scoping lookup to the authenticated user", async () => {
    const fileId = "missing";
    const { token, userId } = mintFileReadToken("download_missing");

    mockS3Objects([]);

    const response = await requestDownload({ fileId, token });

    await expectErrorResponse(response, 404, "NOT_FOUND");
    const prefixes = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command).Prefix;
      })
      .filter((prefix): prefix is string => {
        return typeof prefix === "string";
      });
    expect(prefixes).toContain(`artifacts/${userId}/${fileId}/`);
  });

  it("downloads file bytes with filename, length, and text/binary headers", async () => {
    const textFileId = "test-file-uuid";
    const textContent = Buffer.from("hello world");
    const encodedFileId = "encoded-name-uuid";
    const encodedContent = Buffer.from([0, 1, 2, 3, 255]);
    const filename = "report 2026 #final.bin";
    const { token, userId } = mintFileReadToken("download_body");
    mockS3Objects([
      {
        key: artifactKey(userId, textFileId, "test_file.txt"),
        size: textContent.length,
        body: textContent,
      },
      {
        key: artifactKey(userId, encodedFileId, filename),
        size: encodedContent.length,
        body: encodedContent,
      },
    ]);

    const textResponse = await requestDownload({
      fileId: textFileId,
      token,
    });

    expect(textResponse.status).toBe(200);
    expect(textResponse.headers.get("content-type")).toBe("text/plain");
    expect(textResponse.headers.get("x-file-name")).toBe("test_file.txt");
    expect(textResponse.headers.get("x-file-mimetype")).toBe("text/plain");
    expect(textResponse.headers.get("content-length")).toBe(
      String(textContent.length),
    );
    await expectDownloadedBody(textResponse, textContent);

    const encodedResponse = await requestDownload({
      fileId: encodedFileId,
      token,
    });

    expect(encodedResponse.status).toBe(200);
    expect(encodedResponse.headers.get("x-file-name")).toBe(
      encodeURIComponent(filename),
    );
    expect(encodedResponse.headers.get("content-length")).toBe(
      String(encodedContent.length),
    );
    await expectDownloadedBody(encodedResponse, encodedContent);
  });

  it("infers image, office, and unknown extension MIME types", async () => {
    const imageFileId = "img-uuid";
    const imageContent = Buffer.from("fake-png-data");
    const officeFileId = "sheet-uuid";
    const officeContent = Buffer.from("fake-xlsx-data");
    const unknownFileId = "bin-uuid";
    const unknownContent = Buffer.from("binary-data");
    const { token, userId } = mintFileReadToken("download_mime");
    mockS3Objects([
      {
        key: artifactKey(userId, imageFileId, "photo.png"),
        size: imageContent.length,
        body: imageContent,
      },
      {
        key: artifactKey(userId, officeFileId, "budget.xlsx"),
        size: officeContent.length,
        body: officeContent,
      },
      {
        key: artifactKey(userId, unknownFileId, "data.xyz"),
        size: unknownContent.length,
        body: unknownContent,
      },
    ]);

    const imageResponse = await requestDownload({
      fileId: imageFileId,
      token,
    });

    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toBe("image/png");
    expect(imageResponse.headers.get("x-file-mimetype")).toBe("image/png");

    const officeResponse = await requestDownload({
      fileId: officeFileId,
      token,
    });
    const officeMimeType =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(officeResponse.status).toBe(200);
    expect(officeResponse.headers.get("content-type")).toBe(officeMimeType);
    expect(officeResponse.headers.get("x-file-mimetype")).toBe(officeMimeType);

    const unknownResponse = await requestDownload({
      fileId: unknownFileId,
      token,
    });

    expect(unknownResponse.status).toBe(200);
    expect(unknownResponse.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
  });

  it("follows paginated S3 listings before streaming the matched file", async () => {
    const fileId = "paged-uuid";
    const content = Buffer.from("paged file");
    const { token, userId } = mintFileReadToken("download_paged");
    mockPaginatedS3Object({
      key: artifactKey(userId, fileId, "paged.txt"),
      size: content.length,
      body: content,
    });

    const response = await requestDownload({ fileId, token });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-file-name")).toBe("paged.txt");
    await expectDownloadedBody(response, content);
  });
});
