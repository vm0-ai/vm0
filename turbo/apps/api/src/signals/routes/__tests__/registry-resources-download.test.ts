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
    const colorSystemFixedSha256 =
      "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad";

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
    expect(
      resolvePrivateRegistryResourceArchive(
        id,
        colorSystemFixedSha256,
        legacySha256,
      ),
    ).toMatchObject({
      versionId:
        "c063961c29369b15b8ae7a3cb285105bc29dbae84cccc36d458b666a5ca75e06",
      sha256: colorSystemFixedSha256,
    });
  });

  it("resolves every additive website v2 archive without changing the legacy default", () => {
    const legacySha256 =
      "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3";

    expect(
      resolvePrivateRegistryResourceArchive(
        "template:black-slabs",
        undefined,
        legacySha256,
      ),
    ).toMatchObject({
      versionId:
        "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
      sha256: legacySha256,
    });

    const v2Archives = [
      {
        id: "template:black-slabs-v2",
        versionId:
          "3aefcd4de6a6e319ec88b19a1747d0940bcf9b0027298154572f99e4e3ff3697",
        sha256:
          "0f12d8408536ce4e0178129db5ceecc3b7d77605eaff76bff8fab04fd6193c22",
      },
      {
        id: "template:blueprint-grid-v2",
        versionId:
          "77980498c47758043a2f11d1eed6a65d2aad2cc4847ef6c51cb9dfd759fe52f2",
        sha256:
          "38737948531b22ab5ae03c537464b948b48e139ca0362ea68e9dd3daaf6760b6",
      },
      {
        id: "template:coastal-hotel-v2",
        versionId:
          "7367f07e13219a0b9c246440f9dcd13ed7840322a5912ec684b342185f7bc86c",
        sha256:
          "5c8650684d247143e010859d957c58c3c77d2b4e3a5540dbb4c4961cc2d70d54",
      },
      {
        id: "template:dot-matrix-v2",
        versionId:
          "108458f32cade6a87f76acd5308e23d2169544bb2591da285c629cfbcf6e9fbf",
        sha256:
          "20931f59434fea45e2772dd4a2a7790572f65b3514b84bfbb245968618f0ad44",
      },
      {
        id: "template:frame-stack-v2",
        versionId:
          "892cbceb2ae49855637e4684821f2b5c5ac04769800527c3ca4f66e115d7c8d7",
        sha256:
          "628139021e196f12e06723d899d299a89dc16696870fede38fc9864b6ffff9c1",
      },
      {
        id: "template:frosted-scatter-v2",
        versionId:
          "d6950c76df5ffa3f96336f68915fd0670de7ff0f73d07e97b82f63f934d856f3",
        sha256:
          "3b0fab9f9f52434f37686377793dae2e467e818e48b85b6696f862d9e8e23232",
      },
      {
        id: "template:gallery-wall-v2",
        versionId:
          "f4d62d5f46040c51fced1266dac6f590761bc102def7a89ce4cbdceb6bdbbcee",
        sha256:
          "df998b7ca480d24665b49e6c07f4e29eb8f26f3916ed3b8051f41e47535588ab",
      },
      {
        id: "template:glass-bloom-v2",
        versionId:
          "dd233dec6bec872e173858b8788a22ed2fbfee0f6f687d74a42ba84947bbfb5c",
        sha256:
          "b66ec9fda392e13a8f0c71c842cc0b2e655695cf60d7dd28e8db3b322ba35596",
      },
      {
        id: "template:serif-stack-v2",
        versionId:
          "6b7d18315b6955ef27318546ed050ae2736386f80d29f8452f1d74855ef8531c",
        sha256:
          "0641c65b035abab0b53d3b345178688f1b4091083d1b7c574b640537b49ef3e5",
      },
      {
        id: "template:sticker-pop-v2",
        versionId:
          "21c5247800c02f53b87d27d0970707f642a51dd56a9ef0a8fce68ca8ea677783",
        sha256:
          "4b076e69118268108e550322cdfe9befd91378bee5d28bf73627df54ccbaacbd",
      },
      {
        id: "template:warm-cards-v2",
        versionId:
          "040325e9aa9567d79532c61933d04fdb10e268d371dca30ae793585da1325eaf",
        sha256:
          "20f0a7fa09bf2653b55fb0323b050accaa565817587d105b98ada03243b75bf3",
      },
    ] as const;

    for (const archive of v2Archives) {
      expect(
        resolvePrivateRegistryResourceArchive(
          archive.id,
          archive.sha256,
          archive.sha256,
        ),
      ).toMatchObject({
        versionId: archive.versionId,
        sha256: archive.sha256,
      });
    }
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
