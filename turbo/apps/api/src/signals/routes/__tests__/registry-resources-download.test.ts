import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import { findWebsiteTemplateResource } from "@vm0/core/resource-registry";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { seedPrivateRegistryResourceVersionFixture } from "../../../test-fixtures/private-registry-resource";
import {
  resolvePrivateRegistryResourceArchive,
  registryResourceDownloadRoutes,
} from "../registry-resources-download";
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
  return setupApp({ context, routes: registryResourceDownloadRoutes })(
    registryResourceDownloadContract,
  );
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

  it("resolves current and previous website template archives", () => {
    const currentStableArchives = [
      {
        id: "template:black-slabs",
        versionId:
          "63e7780407504c15df178658ef2f694baa23d0a2a4199f38ac07fd9a302f5dac",
        sha256:
          "38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9",
      },
      {
        id: "template:blueprint-grid",
        versionId:
          "89c5a11d4a769e880e59a277fe8af1f1c173752ceea7539680d00d5225b3b717",
        sha256:
          "b5f058f3ec7881e642e31e44e7de1f94465bae783de7fc2d42727bbfd109fad2",
      },
      {
        id: "template:coastal-hotel",
        versionId:
          "e5ac62f1ebdf025470172c2ce8275833274de49f6300c427eef0c142523b1246",
        sha256:
          "6bba8c10b85a248a475624767616280fa5d29b757ce230fb4115d746b8b61386",
      },
      {
        id: "template:dot-matrix",
        versionId:
          "173d914b90d68648e9da9ee32cde12417fe55703b22f999b626b07f6053a7488",
        sha256:
          "cfb8f891fa77eca2c3a58f1d95f046f873136f85c9c4a83400cba3a2ccca4ad9",
      },
      {
        id: "template:frame-stack",
        versionId:
          "422a07c5431dc689f2a0f832ffd5085149c64de6575be2c435fef01e36ffdb83",
        sha256:
          "642db1ff8e1c98e4c390245cb0fcda5ce29503721bc2a513c38448b9d4e2d01c",
      },
      {
        id: "template:frosted-scatter",
        versionId:
          "02855a260801c5120ee62c04f3a0b9d4f4884caea89728264cc85c1f6a2d74ad",
        sha256:
          "548a1faf423baa1c7c11befe41a54ae398cfb5c94df7f957eff108e2afcd613a",
      },
      {
        id: "template:gallery-wall",
        versionId:
          "26591a92b37e255dd8d565effc542115dd94292465e179c501c0518538cd27ce",
        sha256:
          "b477b2f05c266eccbd2ab3b822744873dd8a31db03981283688549f2936bd5c6",
      },
      {
        id: "template:glass-bloom",
        versionId:
          "297d1c1ed2639a3eead3212fcb3bf3c59ca80ee36562902cdec46ea8394b7398",
        sha256:
          "8707cce50c5477d43912fd18aa5ab6973aae4fd2287a092967fa25bf4ea38e7c",
      },
      {
        id: "template:serif-stack",
        versionId:
          "165c2c576e7b2fccad2f490c6813e4705d5f87408fa24a8cec79d4ddf2392831",
        sha256:
          "718d617efd92033a68c476e85bb9231b1e0ff580c08a1f6bedf1b86058e97f13",
      },
      {
        id: "template:sticker-pop",
        versionId:
          "c87a666429beb7d8fbaf3376c7229c701b53cdb36f4f714c6b45f0b6fdf3134a",
        sha256:
          "8145c78f932ae942108fba00c5de367958f12b4c492d61bc1310892abe51ca66",
      },
      {
        id: "template:warm-cards",
        versionId:
          "47a5c7f01a7395d5be86483291c26e5f51e3fa8258c0d69705379ea9fb21849f",
        sha256:
          "a795ef022e672d364c7a966eb042d38e460d4dcb996d5eecb0647aac5dd259df",
      },
    ] as const;

    for (const archive of currentStableArchives) {
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

    const previousStableArchives = [
      {
        id: "template:black-slabs",
        versionId:
          "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
        sha256:
          "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3",
        currentSha256:
          "38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9",
      },
      {
        id: "template:blueprint-grid",
        versionId:
          "78988a658604a25feb259d54e4543bfe6d57f85efe7ad67737e02c794d25e491",
        sha256:
          "97c2edd94467bc414f0d9fc27cafa048cb2a7aaba3df5159df519a2bb2b97a4e",
        currentSha256:
          "b5f058f3ec7881e642e31e44e7de1f94465bae783de7fc2d42727bbfd109fad2",
      },
      {
        id: "template:coastal-hotel",
        versionId:
          "3907cdbed6078702a058ed9c66c1cdeb76f83f1062efcf3b046cce0bd5c8ed06",
        sha256:
          "9633475124da5728cbf99a7333b494f74842232faaf675bc7878a3ebcdf59bcb",
        currentSha256:
          "6bba8c10b85a248a475624767616280fa5d29b757ce230fb4115d746b8b61386",
      },
      {
        id: "template:dot-matrix",
        versionId:
          "293a2bc33150ca1f39132a8235c5cf355944e8d3e213b5f7703237314a2ac449",
        sha256:
          "f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2",
        currentSha256:
          "cfb8f891fa77eca2c3a58f1d95f046f873136f85c9c4a83400cba3a2ccca4ad9",
      },
      {
        id: "template:frame-stack",
        versionId:
          "efbf1788c8b084aa12b7cd48f7a3bf5fc9964d1e6115edbd9124f8cacfbfb3ca",
        sha256:
          "4587e93da51652c0c16c2d0706e8437001305214e4e6b8b1c18a6538b3daa127",
        currentSha256:
          "642db1ff8e1c98e4c390245cb0fcda5ce29503721bc2a513c38448b9d4e2d01c",
      },
      {
        id: "template:frosted-scatter",
        versionId:
          "c4507fd54d252dc905df36d99f23ab65a4d41185b78e62515ff3eb3d87a381a4",
        sha256:
          "00e343ace0673ece5903a2b6abbad6bb960c17796e0cfa5cce0bcab7e6bcdd7b",
        currentSha256:
          "548a1faf423baa1c7c11befe41a54ae398cfb5c94df7f957eff108e2afcd613a",
      },
      {
        id: "template:gallery-wall",
        versionId:
          "9e81cd8b35f9f6374440cd3a4a8fc214db4a137962797df69bde46248c4e75f3",
        sha256:
          "c90332053b24572feadecb3994925ed317957e1cb17b0080cfebc6f4d9e93bd1",
        currentSha256:
          "b477b2f05c266eccbd2ab3b822744873dd8a31db03981283688549f2936bd5c6",
      },
      {
        id: "template:glass-bloom",
        versionId:
          "52d38ebc1e62b974f7ab2f6dba8823b0a2f7c43d5c11d8079f32e3ff85df1e50",
        sha256:
          "0c61488baa294fb13c58aa129e3ae99f0cd4ff9125459761a1b2c1390b860f93",
        currentSha256:
          "8707cce50c5477d43912fd18aa5ab6973aae4fd2287a092967fa25bf4ea38e7c",
      },
      {
        id: "template:serif-stack",
        versionId:
          "adee3b87f670c52a3cc4971e5dd8795f8ca05690087caff4b0d8b32b9029bead",
        sha256:
          "cf5137a7b6788f4d7cb24bda358a8e1971c0e7ed026d50e6cf292f6bf0cd0c14",
        currentSha256:
          "718d617efd92033a68c476e85bb9231b1e0ff580c08a1f6bedf1b86058e97f13",
      },
      {
        id: "template:sticker-pop",
        versionId:
          "ddae2ff9236b0a4663dc19ad23b374488c0d4d9eddf9b5a4e8cad36011b0b420",
        sha256:
          "2086113018279f28e23489cf7a0f3663c37a23210fb106c4ed48d8c19923f78f",
        currentSha256:
          "8145c78f932ae942108fba00c5de367958f12b4c492d61bc1310892abe51ca66",
      },
      {
        id: "template:warm-cards",
        versionId:
          "0a87c99afe9cf24424aa1a1740a57cc3698e43f3c571b8ef1fd4560192f38746",
        sha256:
          "2721c013f76e1b2eea09282269b33d7f143b7e83ee3e701e83a0fcf7773852dd",
        currentSha256:
          "a795ef022e672d364c7a966eb042d38e460d4dcb996d5eecb0647aac5dd259df",
      },
    ] as const;

    for (const archive of previousStableArchives) {
      expect(
        resolvePrivateRegistryResourceArchive(
          archive.id,
          archive.sha256,
          archive.currentSha256,
        ),
      ).toMatchObject({
        versionId: archive.versionId,
        sha256: archive.sha256,
      });
    }

    const v2Archives = [
      {
        id: "template:black-slabs-v2",
        versionId:
          "3a7ccdd16e0c710cf20a0deddbd02d3a58a8125d2b3542648bc261bbaf9c5c91",
        sha256:
          "de6f78c5a524cf3959ca56af7a93ec5bca113555bbd1a5983eebf1bc353971d4",
      },
      {
        id: "template:blueprint-grid-v2",
        versionId:
          "c86f579ecca5f29d45eab19ae19157bdc9a9bc14c99cdbf8611b86aaae3aea70",
        sha256:
          "dec02c4fe156566272a92b7386cb032cec7e3a1250dd42429ca3e7f42374dc28",
      },
      {
        id: "template:coastal-hotel-v2",
        versionId:
          "7c13e39abcabf4cb31bdecdac80e096d6e039367e23c55ca0c3e6647d8fb3583",
        sha256:
          "09d239d7a0e1c27334f2c3c8da9e408174cece6bcc8a34342438598db739aa4e",
      },
      {
        id: "template:dot-matrix-v2",
        versionId:
          "9a8977088b02b43d15654674571a88c0128b29076bb8e837d47ddd3a6ea4fd6a",
        sha256:
          "0beb9b1bcb12ace6d3541df269a629af8e3b41c8f9d7e3c3fcfe069655cd9074",
      },
      {
        id: "template:frame-stack-v2",
        versionId:
          "cb8cf528ebfce90e6f78081fbaee0029f2790ff5398ffa0642a6c30c8c1e0c1b",
        sha256:
          "7c4c13eaa22b4185607c6ac6a726dd931fe896b279b38a6267c0105f81214f8b",
      },
      {
        id: "template:frosted-scatter-v2",
        versionId:
          "7cab5008dbe877dd5ac43e3511d06109d101dda389bbdcc4589396ff495d9d41",
        sha256:
          "c67a7baf924ae4b57241e61527dd875d084e38040653a9bbcc659c13d2382cf9",
      },
      {
        id: "template:gallery-wall-v2",
        versionId:
          "c208b3119387422c4487d1a9a6f3c8f1618d0ee77dcfd51cbe26e6b4092cb002",
        sha256:
          "f6e41fb711b8c9317a425b463a9812e99f2aecb630d1acbfb77ef0965c2ba55f",
      },
      {
        id: "template:glass-bloom-v2",
        versionId:
          "fe6ac8450b6f822707c3e38c2705b2b88828c9226befa090086dc53635d9f9b6",
        sha256:
          "713fbac57cf37a0ddd6d7e7d79a0b9f29f8fff7a0aa55bc741bc5dcd0e498d25",
      },
      {
        id: "template:serif-stack-v2",
        versionId:
          "e61f178818ccf31a0676ca0183fccbaef3019972adab592d8a5ba17287f54f65",
        sha256:
          "6d5d65fb21d6c5ec5627fe32fbfc55e80841a2343f2d91bf3ee3a0f62547766a",
      },
      {
        id: "template:sticker-pop-v2",
        versionId:
          "d358cbcd29fc725fc282f4675ebba533fd60af564038d8efa0d4a057a29aee5b",
        sha256:
          "61954f4652e2cc86cd1016a537078ea050fe95735a7477e6bd56c91a0c0aec3b",
      },
      {
        id: "template:warm-cards-v2",
        versionId:
          "f587c890c6db593a4cd102cb863f2484868277200d5630b40712ee8b2ded3153",
        sha256:
          "213197ef200b16738b51b5d6c4a90b6e6c12c86c63207ef6afc31456cdd0d2e1",
      },
    ] as const;

    for (const archive of v2Archives) {
      // The pinned digest must be the one the registry ships, otherwise the
      // version ids below would be resolved for an archive nobody pulls.
      expect(
        findWebsiteTemplateResource(archive.id)?.source.archive,
      ).toStrictEqual({
        type: "tar.gz",
        sha256: archive.sha256,
      });

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
        query: { id: "template:dashboard", expectedSha256: "0".repeat(64) },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
