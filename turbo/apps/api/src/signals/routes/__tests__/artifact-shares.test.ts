import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { expect, test } from "vitest";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { testContext, accept } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { artifactShareRoutes } from "../artifact-shares";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { webFileUrlRoutes } from "../web-file-url";
import { createRouteMocks } from "./helpers/route-test";
import { createBddApi } from "./helpers/api-bdd";
import { createHostMapsBddApi } from "./helpers/api-bdd-host-maps";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { hostedTextFile } from "./helpers/api-bdd-host-files";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

class ClerkApiResponseTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";

  constructor(readonly status: number) {
    super(`Clerk Backend API request failed with status ${status}`);
  }
}

const api = () => {
  return setupApp({
    context,
    routes: [
      ...artifactShareRoutes,
      ...featureSwitchesRoutes,
      ...uploadsPrepareRoutes,
      ...uploadsCompleteRoutes,
      ...webFileUrlRoutes,
    ],
  });
};
async function flag(enabled: boolean) {
  await accept(
    api()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.PrivateArtifacts]: enabled } },
    }),
    [200],
  );
}
async function file() {
  const prepared = await accept(
    api()(uploadsContract).prepare({
      headers,
      body: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: 13,
        purpose: "artifact",
      },
    }),
    [200],
  );
  await accept(
    api()(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  return { kind: "file" as const, id: prepared.body.id };
}

async function fixture() {
  const owner = `user_${randomUUID()}`;
  const org = `org_${randomUUID()}`;
  const members = new Set([owner]);
  const objects = new Map<string, string>();
  const etag = (body: string) => {
    return `"${createHash("md5").update(body).digest("hex")}"`;
  };
  mockEnv("OKOU_API_BACKEND_URL", "https://api.okou.ai");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockEnv("OKOU_PUBLIC_HOST_DOMAIN", "okou.app");
  mockEnv("OKOU_HOST_SCHEME", "https");
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue({
    id: org,
    name: "Original organization",
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
    (input) => {
      const params = z
        .object({
          organizationId: z.string(),
          userId: z.array(z.string()),
          limit: z.literal(1),
        })
        .parse(input);
      expect(params.organizationId).toBe(org);
      return Promise.resolve({
        data: params.userId
          .filter((id: string) => {
            return members.has(id);
          })
          .map((id: string) => {
            return {
              publicUserData: { userId: id },
              role: "org:member",
            };
          }),
        totalCount: members.size,
      });
    },
  );
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://private-r2.example/report.pdf?signature=temporary",
  );
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (cmd instanceof ListObjectsV2Command) {
      return Promise.resolve({ Contents: [] });
    }
    if (cmd instanceof HeadObjectCommand) {
      return Promise.resolve({
        ContentLength: 13,
        ContentType: "application/pdf",
        Metadata: { "artifact-id": cmd.input.Key?.split("/")[1] },
      });
    }
    if (cmd instanceof CopyObjectCommand) {
      return Promise.resolve({});
    }
    if (cmd instanceof PutObjectCommand) {
      const previous = objects.get(cmd.input.Key!);
      if (
        (cmd.input.IfNoneMatch === "*" && previous !== undefined) ||
        (cmd.input.IfMatch &&
          (previous === undefined || cmd.input.IfMatch !== etag(previous)))
      ) {
        return Promise.reject(
          Object.assign(new Error("Stale policy write"), {
            name: "PreconditionFailed",
          }),
        );
      }
      objects.set(cmd.input.Key!, String(cmd.input.Body));
      return Promise.resolve({});
    }
    if (cmd instanceof GetObjectCommand) {
      const body = objects.get(cmd.input.Key!);
      if (body === undefined) {
        return Promise.reject(
          Object.assign(new Error("Missing"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        Body: Readable.from([Buffer.from(body)]),
        ETag: etag(body),
      });
    }
    throw new Error("Unexpected storage operation");
  });
  function session(userId = owner, orgId: string | null = org) {
    mocks.clerk.session(userId, orgId);
  }
  session();
  await flag(true);
  return { owner, org, members, objects, session };
}

test("viewing and copying stable references grant nothing; only the owner can manage sharing", async () => {
  const { objects, members, session } = await fixture();
  const target = await file();
  const initial = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(initial.body).toMatchObject({
    audience: "private",
    shareId: null,
    url: null,
  });
  expect(objects.size).toBe(0);
  const peer = `user_${randomUUID()}`;
  members.add(peer);
  session(peer);
  await flag(true);
  await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [404],
  );
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [404],
  );
  await accept(
    api()(webFilesContract).fileUrl({ headers, query: { file_id: target.id } }),
    [404],
  );
  session();
  await flag(false);
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [403],
  );
  expect(objects.size).toBe(0);
});

test("organization resolution checks current original-org membership and never grants reshare rights", async () => {
  const { members, session } = await fixture();
  const target = await file();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  const id = shared.body.shareId!;
  expect(shared.body.url).toBe(`https://app.okou.ai/share/artifacts/${id}`);
  expect(shared.headers.get("cache-control")).toBe("private, no-store");
  const recipient = `user_${randomUUID()}`;
  session(recipient, `org_${randomUUID()}`);
  await accept(
    api()(artifactSharesContract).resolve({ headers, params: { id } }),
    [404],
  );
  members.add(recipient);
  const allowed = await accept(
    api()(artifactSharesContract).resolve({ headers, params: { id } }),
    [200],
  );
  expect(allowed.body.url).toContain("signature=temporary");
  expect(allowed.headers.get("cache-control")).toBe("private, no-store");
  expect(context.mocks.s3.getSignedUrl.mock.calls.at(-1)).toMatchObject({
    2: { expiresIn: 900 },
  });
  await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [404],
  );
  members.delete(recipient);
  await accept(
    api()(artifactSharesContract).resolve({ headers, params: { id } }),
    [404],
  );
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const anonymous = await accept(
    api()(artifactSharesContract).resolve({ headers: {}, params: { id } }),
    [401],
  );
  expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
});

test("a deleted original organization makes an existing share unavailable", async () => {
  const { session } = await fixture();
  const target = await file();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
    new ClerkApiResponseTestError(404),
  );
  session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  const response = await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: shared.body.shareId! },
    }),
    [404],
  );
  expect(response.body).toStrictEqual({
    error: { code: "NOT_FOUND", message: "Artifact unavailable" },
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");

  session();
  await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [404],
  );
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [404],
  );
});

test.each([
  ["provider outage", new ClerkApiResponseTestError(503)],
  ["rate limit", new ClerkApiResponseTestError(429)],
  [
    "unclassified failure",
    Object.assign(new Error("Failure"), { status: 404 }),
  ],
])(
  "a membership %s remains an error rather than a missing organization",
  async (_name, error) => {
    await fixture();
    const target = await file();
    const shared = await accept(
      api()(artifactSharesContract).update({
        headers,
        body: { target, audience: "organization" },
      }),
      [200],
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockRejectedValue(
      error,
    );
    const response = await accept(
      api()(artifactSharesContract).resolve({
        headers,
        params: { id: shared.body.shareId! },
      }),
      [500],
    );
    expect(response.body).not.toHaveProperty("url");
  },
);

test("audience changes revoke old public tokens; rollback preserves grants and permits stopping", async () => {
  const { objects } = await fixture();
  const target = await file();
  const publicShare = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(publicShare.body.url).toMatch(
    /^https:\/\/sh-[a-f0-9]{32}-[a-f0-9]{24}\.okou\.app\/$/u,
  );
  const first = publicShare.body;
  const organization = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  expect(organization.body.shareId).toBe(first.shareId);
  expect(JSON.parse([...objects.values()][0]!)).toMatchObject({
    audience: "organization",
    publicToken: null,
  });
  const republished = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(republished.body.url).not.toBe(first.url);
  await flag(false);
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: first.shareId! },
    }),
    [200],
  );
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "private" },
    }),
    [200],
  );
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: first.shareId! },
    }),
    [404],
  );
  expect(JSON.parse([...objects.values()][0]!)).toMatchObject({
    status: "revoked",
    audience: "private",
    publicToken: null,
  });
});

test("html sharing pins the selected version until an explicit update and resolves to isolated content", async () => {
  const { owner, org, objects } = await fixture();
  const actor = createBddApi(context).user({ userId: owner, orgId: org });
  await createRunsApi(context).grantProEntitlement(actor);
  const host = createHostMapsBddApi(context);
  const body = {
    site: `sharing-${randomUUID().slice(0, 8)}`,
    artifactKind: "hosted-site" as const,
    spaFallback: false,
    files: [hostedTextFile("/index.html", "<h1>Version one</h1>")],
  };
  const first = await host.prepareHostedSite(actor, body);
  await host.completeHostedSite(actor, first.deploymentId);
  const target = { kind: "html" as const, id: first.deploymentId };
  const share = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  const second = await host.prepareHostedSite(actor, {
    ...body,
    files: [hostedTextFile("/index.html", "<h1>Version two</h1>")],
  });
  await host.completeHostedSite(actor, second.deploymentId);
  const newer = { kind: "html" as const, id: second.deploymentId };
  const before = await accept(
    api()(artifactSharesContract).status({ headers, body: newer }),
    [200],
  );
  expect(before.body).toMatchObject({
    selectedTarget: target,
    selectedVersion: 1,
    candidateVersion: 2,
    url: share.body.url,
  });
  const resolve = await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: share.body.shareId! },
    }),
    [200],
  );
  expect(resolve.body.url).toMatch(/^https:\/\/ps-[a-f0-9]{48}\.okou\.app\/$/u);
  const token = new URL(resolve.body.url).hostname.slice(3).split(".")[0];
  expect(objects.has(`shared-previews/okou/${token}.json`)).toBeTruthy();
  expect(objects.has(`private-previews/okou/${token}.json`)).toBeFalsy();
  expect(
    [...objects.values()].some((value) => {
      return value.includes(`"deploymentId":"${first.deploymentId}"`);
    }),
  ).toBeTruthy();
  const changed = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target: newer, audience: "organization" },
    }),
    [200],
  );
  expect(changed.body).toMatchObject({
    selectedTarget: newer,
    selectedVersion: 2,
    url: share.body.url,
  });
});

test("a failed publication write does not report a narrower audience, and unavailable policy fails closed", async () => {
  await fixture();
  const target = await file();
  const first = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (
      cmd instanceof PutObjectCommand &&
      cmd.input.Key?.startsWith("artifact-shares/")
    ) {
      return Promise.reject(new Error("Storage write unavailable"));
    }
    return storage(cmd);
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [500],
  );
  const state = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(state.body).toMatchObject({ audience: "public", url: first.body.url });
  context.mocks.s3.send.mockRejectedValue(new Error("Storage unavailable"));
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: first.body.shareId! },
    }),
    [500],
  );
});

test("sharing copies file bytes once into private storage without changing the owner reference", async () => {
  await fixture();
  const target = await file();
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "organization" },
    }),
    [200],
  );
  const copies = context.mocks.s3.send.mock.calls.filter(([cmd]) => {
    return cmd instanceof CopyObjectCommand;
  });
  expect(copies).toHaveLength(1);
  expect(copies[0]?.[0]).toMatchObject({
    input: {
      Bucket: "test-private-artifacts",
      CopySource: `test-private-artifacts/private-artifacts/${target.id}/report.pdf`,
      Key: expect.stringContaining(`/shares/`),
    },
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  expect(
    context.mocks.s3.send.mock.calls.filter(([cmd]) => {
      return cmd instanceof CopyObjectCommand;
    }),
  ).toHaveLength(1);
  const ownerPreview = await accept(
    api()(webFilesContract).fileUrl({ headers, query: { file_id: target.id } }),
    [200],
  );
  expect(ownerPreview.body.publicUrl).toBeNull();
});

test("a delayed writer cannot resurrect a public grant after a newer revocation", async () => {
  const { objects } = await fixture();
  const target = await file();
  const shared = await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [200],
  );
  const key = `artifact-shares/okou/${shared.body.shareId}.json`;
  const storage = context.mocks.s3.send.getMockImplementation()!;
  context.mocks.s3.send.mockImplementation((cmd) => {
    if (cmd instanceof PutObjectCommand && cmd.input.Key === key) {
      // A different writer committed after this request's read. R2 must reject
      // its stale If-Match even if the old process lost its database row lock.
      const previous = JSON.parse(objects.get(key)!);
      objects.set(
        key,
        JSON.stringify({
          ...previous,
          revision: randomUUID(),
          audience: "private",
          status: "revoked",
          publicToken: null,
        }),
      );
    }
    return storage(cmd);
  });
  await accept(
    api()(artifactSharesContract).update({
      headers,
      body: { target, audience: "public" },
    }),
    [500],
  );
  const status = await accept(
    api()(artifactSharesContract).status({ headers, body: target }),
    [200],
  );
  expect(status.body).toMatchObject({ audience: "private", url: null });
  await accept(
    api()(artifactSharesContract).resolve({
      headers,
      params: { id: shared.body.shareId! },
    }),
    [404],
  );
});
