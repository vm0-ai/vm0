import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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
  // Deployment compatibility is a small old/new request-state matrix. Keeping
  // it direct avoids requiring production R2 version hashes in the test DB.
  it("keeps legacy clients on the default archive and lets new clients opt in", () => {
    const id = "template:html-ppt-schoolhouse-runbook";
    const legacySha256 =
      "9bd19af256dfb6f17073ec9af52ed0163a5f432a3d143eb82f1fa67aaf8b015e";
    const refreshedSha256 =
      "bb3e49899d1bcd24b1e88ba8566a9ddd09039502fb51becffcd9f35051463e63";

    expect(
      resolvePrivateRegistryResourceArchive(id, undefined, legacySha256),
    ).toMatchObject({
      versionId:
        "a34ed3483769cc2825656849385b86f23c50e5500d8ab20e7a705019949e49a5",
      sha256: legacySha256,
    });
    expect(
      resolvePrivateRegistryResourceArchive(id, refreshedSha256, legacySha256),
    ).toMatchObject({
      versionId:
        "d792e4b858ac0ffeb0e0f4073730453d9753c9e654bdc671f7b2e94d6a40bd17",
      sha256: refreshedSha256,
    });
  });

  it("rejects registry resources that are not in the private archive allowlist", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id: "template:dashboard" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
