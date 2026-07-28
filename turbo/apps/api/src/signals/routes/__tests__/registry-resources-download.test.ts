import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { seedPrivateRegistryResourceVersionFixture } from "../../../test-fixtures/private-registry-resource";
import { resolvePrivateRegistryResourceArchive } from "../registry-resources-download";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const routeMocks = createZeroRouteMocks(context);

function authHeaders() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  routeMocks.clerk.session(userId, orgId, "org:admin");
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(registryResourceDownloadContract);
}

describe("registry resource download", () => {
  it("resolves the presentation archive for the current registry digest", () => {
    const currentSha256 =
      "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad";

    expect(
      resolvePrivateRegistryResourceArchive(
        "template:html-ppt-schoolhouse-runbook",
        currentSha256,
        currentSha256,
      ),
    ).toStrictEqual({
      storageName: "registry-resource@template:html-ppt-schoolhouse-runbook",
      versionId:
        "c063961c29369b15b8ae7a3cb285105bc29dbae84cccc36d458b666a5ca75e06",
      sha256: currentSha256,
    });
  });

  it("rejects a registry digest that differs from the current registry", () => {
    expect(
      resolvePrivateRegistryResourceArchive(
        "template:html-ppt-schoolhouse-runbook",
        "9bd19af256dfb6f17073ec9af52ed0163a5f432a3d143eb82f1fa67aaf8b015e",
        "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad",
      ),
    ).toBeUndefined();
  });

  it("downloads a manually published image style archive through the route", async () => {
    const id = "image-style:vm0-illustration";
    const sha256 =
      "03e77d6968190b9f1888a900963135e92f75b40a6c37e1c1bae999ea49669a37";
    const versionId =
      "820d2e2ce81805d935e4098d5b6f2899967c2ad5c0af4586f794010c6db66966";
    const s3Key = "registry-fixture/vm0-illustration/version";
    const fixture = await seedPrivateRegistryResourceVersionFixture({
      storageName: `registry-resource@${id}`,
      versionId,
      s3Key,
      size: 6054,
      archiveSize: 2621,
      fileCount: 1,
    });
    onTestFinished(fixture.cleanup);

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/vm0-illustration.tar.gz",
    );

    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id, expectedSha256: sha256 },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://r2.example.com/registry/vm0-illustration.tar.gz",
      id,
      type: "tar.gz",
      sha256,
      expiresInSeconds: 900,
      versionId,
      fileCount: 1,
      size: 6054,
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signedCommand).toMatchObject({
      input: {
        Bucket: "registry-resource-test",
        Key: `${s3Key}/archive.tar.gz`,
      },
    });
  });

  it("resolves the current built-in website archive", () => {
    const currentSha256 =
      "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3";

    expect(
      resolvePrivateRegistryResourceArchive(
        "template:black-slabs",
        currentSha256,
        currentSha256,
      ),
    ).toMatchObject({
      versionId:
        "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
      sha256: currentSha256,
    });
  });

  it("rejects retired website template v2 archives", () => {
    expect(
      resolvePrivateRegistryResourceArchive(
        "template:black-slabs-v2",
        "retired",
        "retired",
      ),
    ).toBeUndefined();
  });

  it("rejects registry resources that are not in the private archive allowlist", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id: "template:dashboard", expectedSha256: "0".repeat(64) },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
