import { randomUUID } from "node:crypto";
import { createStore } from "ccstate";
import { describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-context";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { zeroWebFileUrlRoutes } from "../zero-web-file-url";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";

const context = testContext();
const store = createStore();
const BUCKET = "test-user-artifacts";
const ROUTE = "/api/zero/web/file-url";
const PRESIGNED_URL = "https://r2.example.com/artifacts/photo.png?sig=test";

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
  await store.set(seedOrgMembership$, { orgId, userId }, context.signal);
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

function signedObjectInputs(): Record<string, unknown>[] {
  return context.mocks.s3.getSignedUrl.mock.calls.map(([, command]) => {
    return commandInput(command);
  });
}

function signedOptions(): unknown[] {
  return context.mocks.s3.getSignedUrl.mock.calls.map(([, , options]) => {
    return options;
  });
}

function mockS3Objects(keys: readonly string[]): void {
  mockEnv("R2_USER_ARTIFACTS_BUCKET_NAME", BUCKET);
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const input = commandInput(command);
    const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
    const prefix = typeof input.Prefix === "string" ? input.Prefix : undefined;

    if (prefix !== undefined) {
      return Promise.resolve({
        Contents: keys
          .filter((key) => {
            return key.startsWith(prefix) && bucket === BUCKET;
          })
          .map((key) => {
            return {
              Key: key,
              Size: 4,
              LastModified: new Date("2025-01-01T00:00:00.000Z"),
            };
          }),
      });
    }

    return Promise.resolve({});
  });
}

function requestFileUrl(args: {
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
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: zeroWebFileUrlRoutes,
  });
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

describe("GET /api/zero/web/file-url", () => {
  it("returns 401 when no auth token is provided", async () => {
    const response = await requestFileUrl({ fileId: "abc" });

    await expectErrorResponse(response, 401, "UNAUTHORIZED");
  });

  it("returns 403 for a zero token without file:read capability", async () => {
    const token = mintZeroToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["agent:read"],
    });

    const response = await requestFileUrl({ fileId: "abc", token });

    await expectErrorResponse(response, 403, "FORBIDDEN");
  });

  it("returns 400 when file_id query param is missing", async () => {
    const { token } = await mintFileReadToken();

    const response = await requestFileUrl({ token });

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 400 when file_id query param is empty", async () => {
    const { token } = await mintFileReadToken();

    const response = await requestFileUrl({ fileId: "", token });

    await expectErrorResponse(response, 400, "BAD_REQUEST");
  });

  it("returns 404 when the file is not found in S3", async () => {
    const { token } = await mintFileReadToken();
    mockS3Objects([]);

    const response = await requestFileUrl({ fileId: "missing", token });

    await expectErrorResponse(response, 404, "NOT_FOUND");

    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();
  });

  it("signs the resolved object key for the owning user", async () => {
    const fileId = randomUUID();
    const { token, userId } = await mintFileReadToken();
    const key = artifactKey(userId, fileId, "photo.png");
    mockS3Objects([key]);
    context.mocks.s3.getSignedUrl.mockResolvedValue(PRESIGNED_URL);

    const response = await requestFileUrl({ fileId, token });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly url?: string };
    expect(body.url).toBe(PRESIGNED_URL);

    expect(signedObjectInputs()).toStrictEqual([
      expect.objectContaining({ Bucket: BUCKET, Key: key }),
    ]);
    expect(signedOptions()).toStrictEqual([{ expiresIn: 7200 }]);
  });

  it("signs an inline URL without a download disposition", async () => {
    const fileId = randomUUID();
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([artifactKey(userId, fileId, "photo.png")]);

    const response = await requestFileUrl({ fileId, token });

    expect(response.status).toBe(200);
    expect(
      signedObjectInputs().map((input) => {
        return input.ResponseContentDisposition;
      }),
    ).toStrictEqual([undefined]);
  });

  it("does not sign a URL for a file owned by another user", async () => {
    const fileId = randomUUID();
    const owner = await mintFileReadToken();
    mockS3Objects([artifactKey(owner.userId, fileId, "private_notes.md")]);

    const ownerResponse = await requestFileUrl({
      fileId,
      token: owner.token,
    });
    expect(ownerResponse.status).toBe(200);

    const otherUser = await mintFileReadToken();
    const forbiddenResponse = await requestFileUrl({
      fileId,
      token: otherUser.token,
    });

    await expectErrorResponse(forbiddenResponse, 404, "NOT_FOUND");
  });

  it("scopes file lookup to the authenticated user", async () => {
    const fileId = "scoped-uuid";
    const { token, userId } = await mintFileReadToken();
    mockS3Objects([]);

    await requestFileUrl({ fileId, token });

    const prefixes = context.mocks.s3.send.mock.calls
      .map(([command]) => {
        return commandInput(command).Prefix;
      })
      .filter((prefix): prefix is string => {
        return typeof prefix === "string";
      });
    expect(prefixes).toContain(`artifacts/${userId}/${fileId}/`);
  });
});
