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

  it("resolves every refreshed additive website v2 archive", () => {
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
          "bfdd76866483fc78cf49f1e05a55732c3001dc6edd0899433367773eb3ec2435",
        sha256:
          "0f12d8408536ce4e0178129db5ceecc3b7d77605eaff76bff8fab04fd6193c22",
      },
      {
        id: "template:blueprint-grid-v2",
        versionId:
          "d7b65f9e32a9dc691ba9f96dfc45945d034ee7e841d53ff904a41038574572a3",
        sha256:
          "38737948531b22ab5ae03c537464b948b48e139ca0362ea68e9dd3daaf6760b6",
      },
      {
        id: "template:coastal-hotel-v2",
        versionId:
          "9851c21802d2c96cb0d6a4b799f73249287b1ed8b46ab94cb719ce4d9f38c3e8",
        sha256:
          "5c8650684d247143e010859d957c58c3c77d2b4e3a5540dbb4c4961cc2d70d54",
      },
      {
        id: "template:dot-matrix-v2",
        versionId:
          "c3dc44d2445926f7bdc65e017028155aff73d7d59bc0deb783faf6ba689dcf5b",
        sha256:
          "20931f59434fea45e2772dd4a2a7790572f65b3514b84bfbb245968618f0ad44",
      },
      {
        id: "template:frame-stack-v2",
        versionId:
          "4b29a3ccedbd2259f2663e9bae60bafe0ca03ab98c415c0d2624f2dbd5379972",
        sha256:
          "628139021e196f12e06723d899d299a89dc16696870fede38fc9864b6ffff9c1",
      },
      {
        id: "template:frosted-scatter-v2",
        versionId:
          "5076edab7ea87ad666e04ce74e8781f19eda8c660c697834d97a4e0d161f3035",
        sha256:
          "3b0fab9f9f52434f37686377793dae2e467e818e48b85b6696f862d9e8e23232",
      },
      {
        id: "template:gallery-wall-v2",
        versionId:
          "26e2033b18e1a1c2efed697b3b29b0f8e589c4556de34bd2caff1dc801b377e5",
        sha256:
          "df998b7ca480d24665b49e6c07f4e29eb8f26f3916ed3b8051f41e47535588ab",
      },
      {
        id: "template:glass-bloom-v2",
        versionId:
          "3fc6629067c9581ccccd11b679e99e26dbbd45b9d15cce182ce4edb224216d1e",
        sha256:
          "b66ec9fda392e13a8f0c71c842cc0b2e655695cf60d7dd28e8db3b322ba35596",
      },
      {
        id: "template:serif-stack-v2",
        versionId:
          "00b1f6cbce5f93d1df53adc3519b7f32ebc9c1417c78a88b7f2e98fa7aff231e",
        sha256:
          "0641c65b035abab0b53d3b345178688f1b4091083d1b7c574b640537b49ef3e5",
      },
      {
        id: "template:sticker-pop-v2",
        versionId:
          "438eea8bf5a75642d2d645c035314416e1a0a44c9462d33b3fd6b36c6f21f673",
        sha256:
          "4b076e69118268108e550322cdfe9befd91378bee5d28bf73627df54ccbaacbd",
      },
      {
        id: "template:warm-cards-v2",
        versionId:
          "736c14987395cb828dfa3626ace6ea947ca9852509b64d2867c6be105bdb8a12",
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
