import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";
import { findWebsiteTemplateResource } from "@okouai/core/resource-registry";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { seedPrivateRegistryResourceVersionFixture } from "../../../test-fixtures/private-registry-resource";
import {
  resolvePrivateRegistryResourceArchive,
  registryResourceDownloadRoutes,
} from "../registry-resources-download";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const routeMocks = createRouteMocks(context);

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
  const CURRENT_PRESENTATION_SHA256 =
    "e37fd617e744c2e89765ec0b24a30977ad89a876a30176e0bacf8e32209f5394";

  it("downloads the current presentation template HEAD by resource id", async () => {
    const id = "template:html-ppt-schoolhouse-runbook";
    const anchorVersionId =
      "81e7f95dd13cec5f08f54ac965c51b62f87d9c7f8d29370c027aeeed3758571c";
    const headVersionId = "a".repeat(64);
    const s3Key = "registry-fixture/schoolhouse-runbook/latest";
    const fixture = await seedPrivateRegistryResourceVersionFixture({
      storageName: `registry-resource@${id}`,
      versionId: anchorVersionId,
      s3Key: "registry-fixture/schoolhouse-runbook/anchor",
      size: 4321,
      archiveSize: 1234,
      fileCount: 12,
      headVersion: {
        versionId: headVersionId,
        s3Key,
        size: 5432,
        archiveSize: 2345,
        fileCount: 13,
      },
    });
    onTestFinished(fixture.cleanup);

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/schoolhouse-runbook-latest.tar.gz",
    );

    const response = await accept(
      client().downloadPresentationTemplate({
        headers: authHeaders(),
        query: { id },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://r2.example.com/registry/schoolhouse-runbook-latest.tar.gz",
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signedCommand).toMatchObject({
      input: {
        Bucket: "registry-resource-test",
        Key: `${s3Key}/archive.tar.gz`,
      },
    });
  });

  it("keeps non-presentation resources off the current-template route", async () => {
    const response = await accept(
      client().downloadPresentationTemplate({
        headers: authHeaders(),
        query: { id: "image-style:vm0-illustration" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("downloads the presentation archive for the current registry digest", async () => {
    const id = "template:html-ppt-schoolhouse-runbook";
    const versionId =
      "81e7f95dd13cec5f08f54ac965c51b62f87d9c7f8d29370c027aeeed3758571c";
    const s3Key = "registry-fixture/schoolhouse-runbook/version";
    const fixture = await seedPrivateRegistryResourceVersionFixture({
      storageName: `registry-resource@${id}`,
      versionId,
      s3Key,
      size: 4321,
      archiveSize: 1234,
      fileCount: 12,
    });
    onTestFinished(fixture.cleanup);

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/schoolhouse-runbook.tar.gz",
    );

    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id, expectedSha256: CURRENT_PRESENTATION_SHA256 },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      url: "https://r2.example.com/registry/schoolhouse-runbook.tar.gz",
      id,
      type: "tar.gz",
      sha256: CURRENT_PRESENTATION_SHA256,
      expiresInSeconds: 900,
      versionId,
      fileCount: 12,
      size: 4321,
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signedCommand).toMatchObject({
      input: {
        Bucket: "registry-resource-test",
        Key: `${s3Key}/archive.tar.gz`,
      },
    });
  });

  it("rejects an unpublished presentation registry digest through the route", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: {
          id: "template:html-ppt-schoolhouse-runbook",
          expectedSha256:
            "9bd19af256dfb6f17073ec9af52ed0163a5f432a3d143eb82f1fa67aaf8b015e",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
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

  it("downloads the presentation reverse-template guide through the route", async () => {
    const id = "skill:presentation-reverse-template";
    const sha256 =
      "a3184b6718dd1fd4aefa3782695a8e4940babede8db0593a80254232fc90eaec";
    const versionId =
      "2037e27e217c21a5adac76efdd3298e3e8149de030840c8f40521433e22a1c49";
    const s3Key = "registry-fixture/presentation-reverse-template/version";
    const fixture = await seedPrivateRegistryResourceVersionFixture({
      storageName: `registry-resource@${id}`,
      versionId,
      s3Key,
      size: 10_577,
      archiveSize: 4_187,
      fileCount: 3,
    });
    onTestFinished(fixture.cleanup);

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/presentation-reverse-template.tar.gz",
    );

    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id, expectedSha256: sha256 },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id,
      sha256,
      versionId,
      fileCount: 3,
      size: 10_577,
    });
    const signedCommand = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signedCommand).toMatchObject({
      input: {
        Bucket: "registry-resource-test",
        Key: `${s3Key}/archive.tar.gz`,
      },
    });
  });

  it.each([
    {
      sha256:
        "4d11467afafb68c7ac221a4ac66e237cf7a05a8f4bb17c29e09ba6ec64b394b5",
      versionId:
        "108b2ba3b9d1994da6f4f6ddf219992a2ca9f2584edf5f448269d523e8d5b988",
    },
    {
      sha256:
        "4b2bb4ee2a041d57a2fe9ba07b796a690c6dbe130c6e232fa98364b6ed6aeb11",
      versionId:
        "ec707d2338ddec36a4b413ba7fe58c35987b2b85b2a8ecd441add68dcc1472e7",
    },
  ])(
    "still serves reverse-template digest $sha256 to a drained run context",
    ({ sha256, versionId }) => {
      const id = "skill:presentation-reverse-template";
      expect(
        resolvePrivateRegistryResourceArchive(
          id,
          sha256,
          "a3184b6718dd1fd4aefa3782695a8e4940babede8db0593a80254232fc90eaec",
        ),
      ).toStrictEqual({
        storageName: `registry-resource@${id}`,
        versionId,
        sha256,
      });
    },
  );

  it("rejects a reverse-template digest that was never published", () => {
    expect(
      resolvePrivateRegistryResourceArchive(
        "skill:presentation-reverse-template",
        "0".repeat(64),
        "a3184b6718dd1fd4aefa3782695a8e4940babede8db0593a80254232fc90eaec",
      ),
    ).toBeUndefined();
  });

  it("downloads current and previous website template archives", async () => {
    const currentStableArchives = [
      {
        id: "template:black-slabs",
        versionId:
          "037045074360d1e6b499fc37a4c5cad208dfd79e59a53bdea78910c5fbe9f2f9",
        sha256:
          "a2ba4a18fe6be58a05a99fcf755f696629c7cbfe295ec9e4f7685bef1eebff79",
      },
      {
        id: "template:blueprint-grid",
        versionId:
          "bbe1a91664e813adf179071713b159fbcd25c42fe9d06860f2ecaea907b06d2b",
        sha256:
          "b0312334dd8ad42f2e8b219cc0522bd11b0de1d246d133b34d9b832352286468",
      },
      {
        id: "template:coastal-hotel",
        versionId:
          "dfcc93538a28f4dd902e82908991c3ed1ee4657f81b12e425ca3469b0bf67af0",
        sha256:
          "4df5f2099cee35c286af6af9e3413f496a6b45b9423d7308336ad8372468efa3",
      },
      {
        id: "template:dot-matrix",
        versionId:
          "fe4915d7c67bfc7e259192072647f62cb064066b0854a84e7fa7cc85bff43112",
        sha256:
          "5d9f69b7f9625681b5b6183623cbece78c4f40dc6fe585ca799212d05e589623",
      },
      {
        id: "template:frame-stack",
        versionId:
          "e9675a20ab0cc0c3970a21ef88716fd5f6f774bf7107739181d1545d6c39d466",
        sha256:
          "b00cbbe2a39486545d695986b6d2be2def28916d4d21fc80591c64d326ddaa5a",
      },
      {
        id: "template:frosted-scatter",
        versionId:
          "2954955f13a31eeb5a9b5cf69c6c170a92c328ed807eed8573bbac52685e2b16",
        sha256:
          "3aa13240db1b905b8222c3eb7eccacfeec44f93aba30e3f495e0e2f1dc395e58",
      },
      {
        id: "template:gallery-wall",
        versionId:
          "8a2ca4ee5c50294cf54053fc29122196b4265fe5955eeec86bd0967778b86033",
        sha256:
          "41941dd3c92814efc30a36ec8c4929aecda48335619c8684c2e0d3c3d0cbd1fa",
      },
      {
        id: "template:glass-bloom",
        versionId:
          "ad5b00f8a2ceb176aa7de7906345d18ab798d0b6835d86ab1e58bfa033822dee",
        sha256:
          "455acd8f36c55a30b3a58654f3f2d5d20b58fcef379b99a28c52aac54246eaf6",
      },
      {
        id: "template:serif-stack",
        versionId:
          "0dcd6eccf59e23d06c2f4653f001db9bb58b443a0ca0d4bfbd3e411a69ea781d",
        sha256:
          "f6eb7b64155f25e9361fbe4f6ea3eb5e7ed626445472e38d15af52b99204036a",
      },
      {
        id: "template:sticker-pop",
        versionId:
          "1435824e871307371108ca9176b8e67dfe1ba4538d52abbf6e6b7b196f5393ad",
        sha256:
          "3f7fb7f11dcf6524eec1aa2f94fb3df145ae78fc21b7797c23fdfd2ec5ec481a",
      },
      {
        id: "template:warm-cards",
        versionId:
          "1ca8a11a520ed6225a32634fe3f2b0f443d10c28f64098f0f1bd0a795a62f16c",
        sha256:
          "52f5f9670b3d0fba697635d35784bc021a2150f1c84cc73af87c6fd049ed8234",
      },
    ] as const;

    mockEnv("R2_USER_STORAGES_BUCKET_NAME", "registry-resource-test");
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/registry/website-template.tar.gz",
    );

    async function expectArchiveDownload(archive: {
      readonly id: string;
      readonly versionId: string;
      readonly sha256: string;
    }) {
      const fixture = await seedPrivateRegistryResourceVersionFixture({
        storageName: `registry-resource@${archive.id}`,
        versionId: archive.versionId,
        s3Key: `registry-fixture/${archive.versionId}`,
        size: 1,
        archiveSize: 1,
        fileCount: 1,
      });
      onTestFinished(fixture.cleanup);

      const response = await accept(
        client().download({
          headers: authHeaders(),
          query: { id: archive.id, expectedSha256: archive.sha256 },
        }),
        [200],
      );

      expect(response.body).toMatchObject({
        id: archive.id,
        versionId: archive.versionId,
        sha256: archive.sha256,
      });
    }

    for (const archive of currentStableArchives) {
      await expectArchiveDownload(archive);
    }

    const previousStableArchives = [
      {
        id: "template:black-slabs",
        versionId:
          "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
        sha256:
          "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3",
      },
      {
        id: "template:blueprint-grid",
        versionId:
          "78988a658604a25feb259d54e4543bfe6d57f85efe7ad67737e02c794d25e491",
        sha256:
          "97c2edd94467bc414f0d9fc27cafa048cb2a7aaba3df5159df519a2bb2b97a4e",
      },
      {
        id: "template:coastal-hotel",
        versionId:
          "3907cdbed6078702a058ed9c66c1cdeb76f83f1062efcf3b046cce0bd5c8ed06",
        sha256:
          "9633475124da5728cbf99a7333b494f74842232faaf675bc7878a3ebcdf59bcb",
      },
      {
        id: "template:dot-matrix",
        versionId:
          "293a2bc33150ca1f39132a8235c5cf355944e8d3e213b5f7703237314a2ac449",
        sha256:
          "f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2",
      },
      {
        id: "template:frame-stack",
        versionId:
          "efbf1788c8b084aa12b7cd48f7a3bf5fc9964d1e6115edbd9124f8cacfbfb3ca",
        sha256:
          "4587e93da51652c0c16c2d0706e8437001305214e4e6b8b1c18a6538b3daa127",
      },
      {
        id: "template:frosted-scatter",
        versionId:
          "c4507fd54d252dc905df36d99f23ab65a4d41185b78e62515ff3eb3d87a381a4",
        sha256:
          "00e343ace0673ece5903a2b6abbad6bb960c17796e0cfa5cce0bcab7e6bcdd7b",
      },
      {
        id: "template:gallery-wall",
        versionId:
          "9e81cd8b35f9f6374440cd3a4a8fc214db4a137962797df69bde46248c4e75f3",
        sha256:
          "c90332053b24572feadecb3994925ed317957e1cb17b0080cfebc6f4d9e93bd1",
      },
      {
        id: "template:glass-bloom",
        versionId:
          "52d38ebc1e62b974f7ab2f6dba8823b0a2f7c43d5c11d8079f32e3ff85df1e50",
        sha256:
          "0c61488baa294fb13c58aa129e3ae99f0cd4ff9125459761a1b2c1390b860f93",
      },
      {
        id: "template:serif-stack",
        versionId:
          "adee3b87f670c52a3cc4971e5dd8795f8ca05690087caff4b0d8b32b9029bead",
        sha256:
          "cf5137a7b6788f4d7cb24bda358a8e1971c0e7ed026d50e6cf292f6bf0cd0c14",
      },
      {
        id: "template:sticker-pop",
        versionId:
          "ddae2ff9236b0a4663dc19ad23b374488c0d4d9eddf9b5a4e8cad36011b0b420",
        sha256:
          "2086113018279f28e23489cf7a0f3663c37a23210fb106c4ed48d8c19923f78f",
      },
      {
        id: "template:warm-cards",
        versionId:
          "0a87c99afe9cf24424aa1a1740a57cc3698e43f3c571b8ef1fd4560192f38746",
        sha256:
          "2721c013f76e1b2eea09282269b33d7f143b7e83ee3e701e83a0fcf7773852dd",
      },
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
      {
        id: "template:black-slabs",
        versionId:
          "8d5c6ba72363e8e63c2fe8badbd5412c5ca41c32349c2ec63cee757d9a2a1c8d",
        sha256:
          "44126993be4b2932a270efcc21dbc855e60ccc0b280fadedc6ce2c90399f7e17",
      },
      {
        id: "template:blueprint-grid",
        versionId:
          "0ce83ffb4e74289d5dbf7270551290e7774c254660ed86805bd040c8425fd103",
        sha256:
          "9fdf8c7555e85072b9c92526b098edbe90c3230a71f6a1ec08ec3fa902ebabf0",
      },
      {
        id: "template:coastal-hotel",
        versionId:
          "04260e1aa26477d09b7bfb38f03d471a0af5c58f3703fca94d20811097f2ce69",
        sha256:
          "b285b649b73c0b526734ce63b01de5f3f6704ed89f5e71a96f953484a882f979",
      },
      {
        id: "template:dot-matrix",
        versionId:
          "4b4c686788d23a449b75705211432f1609c183149dce8ac9737a94fea2da6861",
        sha256:
          "9bb367c272e46942c33f51c5774b4e229929fd5fb330186bf9a23164bed1c56b",
      },
      {
        id: "template:frame-stack",
        versionId:
          "180a444fb5b96595e480d0218b349d4d2c0bb3c31102e706a292443f67983671",
        sha256:
          "182a63e7b268779b2d45a81651a99da6004873162b1a98d5da27f15be6338d15",
      },
      {
        id: "template:frosted-scatter",
        versionId:
          "73b3b343a96b459b8bcc3da9a41c7ed533ab870c45b64e575326b14c690be337",
        sha256:
          "32fb6fc4ebc85ffa3ea1672cd75005048519dfd1fbc3c1d4c254363d89ebb14e",
      },
      {
        id: "template:gallery-wall",
        versionId:
          "d92042c684c6a50705a5792cd827b6e5b546d6e2b4f376ae80f67610c5564f94",
        sha256:
          "401854b89ea8b8ce98880309a190fa19e03647b564e64bc082ae481f3cb9c8fc",
      },
      {
        id: "template:glass-bloom",
        versionId:
          "6106c1b544fea9d9efb226eae5f0281bb875e9aaa6661afb68b17e129ea2fbe3",
        sha256:
          "ed9f6ef684cc89d5e6653b7f35a62988665a63993ca69305334399652cb7f586",
      },
      {
        id: "template:serif-stack",
        versionId:
          "b499ee4143bae451660589dc732413f42b6e3b0d2fcb26a11f4c1fb9d261e194",
        sha256:
          "55034642b7becda0da90d202c689e79938844142144fef15b5371706bdb3ef46",
      },
      {
        id: "template:sticker-pop",
        versionId:
          "c3b0b7e74e3b61ac9a09bd64317a688c67b8e9f6b19095a965d5deeb46c8d334",
        sha256:
          "d6a8fc7658fe0709a089d819fa745af461e99a1f1759040b60e8b0e4d4eb8ef4",
      },
      {
        id: "template:warm-cards",
        versionId:
          "9fade1ad5c3e5d48ec282d2bad6c0c67ae44da2525d633dd434be3c1d3e3651f",
        sha256:
          "30a7ce127311bcba581793c47f234c043474b9b7bdfca2ba0732bd35e065cee3",
      },
    ] as const;

    for (const archive of previousStableArchives) {
      await expectArchiveDownload(archive);
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
  }, 15_000);

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
