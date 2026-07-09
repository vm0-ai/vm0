import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
  findColorSystem,
  findDesignSystem,
  findPresentationRunbookResource,
  findSkill,
  findTemplate,
  findTool,
  findWebsiteTemplateResource,
} from "@vm0/core/resource-registry";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { seedRegistryArchiveStorage } from "../../../test-fixtures/registry-archive-storage";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const routeMocks = createZeroRouteMocks(context);

const PRIVATE_ARCHIVE_FIXTURES = [
  {
    id: "color-system:bauhaus-primary",
    versionId:
      "26c34a2a33a5c7b751b6741da5e4013020d5dbe138e60f5b3a444f4a5d3a351b",
  },
  {
    id: "color-system:berry-pop",
    versionId:
      "a9e00d18e3042262affb0d1396bd010aa8fa548f6b89e8ae1d634aec37a955b7",
  },
  {
    id: "color-system:carnival",
    versionId:
      "112848d050081ddca2d8ffc57a685906998a7073ddd7585cc4d94f9060b439b8",
  },
  {
    id: "color-system:citrus-fresh",
    versionId:
      "556f9d77f9aa835475b423639e8d642f6e63d5c66f7a4b5b954a37c058292b30",
  },
  {
    id: "color-system:coral-studio",
    versionId:
      "15103787a715de87210ed905a7e35e76694a7a33f3c1a2d734ea54239fba1280",
  },
  {
    id: "color-system:forest-editorial",
    versionId:
      "24cc3c0b4062114e877221d0f50bde4de00c90838d7a54f6013c9038bdd2e19d",
  },
  {
    id: "color-system:gold-luxe",
    versionId:
      "b4c5af7c9bddc8ef1e47d681fadd678852f3b4dc7a9eafd749eca54ba60acbe7",
  },
  {
    id: "color-system:mauve-dusk",
    versionId:
      "181f5d2ee8dfd765563b891693dc145f77a313013f788c799bfefadc231bbcf8",
  },
  {
    id: "color-system:midnight-mono",
    versionId:
      "a9cfc3533f23d04b48e7270a45f4577c5e055509bad35118a23a14ad8c52345b",
  },
  {
    id: "color-system:mint-tech",
    versionId:
      "19bf57aae59ef94b0cb18dcfed6d5ab6d55b3d38f7196c704e9301351820db8d",
  },
  {
    id: "color-system:mono-ink",
    versionId:
      "cc135f036e03e30773d2e01739ed93e0b578f501f44019114e4674bd6a05d932",
  },
  {
    id: "color-system:nordic-frost",
    versionId:
      "a1b0f1018d46dabfb004c933f6a557b43498e8c957e8d5fe1375ab8d1699a9aa",
  },
  {
    id: "color-system:ocean-deep",
    versionId:
      "c848d3aac65c0c9a8f749c61a5aad5f634cf5d7d75d78f1080a45530d3bfdc78",
  },
  {
    id: "color-system:pop-art",
    versionId:
      "82d9330442d86f9969748acf12fd964e9999cad0089b441f57df708cf43ccf79",
  },
  {
    id: "color-system:prism",
    versionId:
      "45c23078172e802ed40e81922b072407bb6a19bf839d5e5be2431d30cc9190c9",
  },
  {
    id: "color-system:slate-corporate",
    versionId:
      "c082c9a8e96aa2c29720e8b06eb827d56f10b0fa5db05112f65cd3a251b65b49",
  },
  {
    id: "color-system:sunset-maroon",
    versionId:
      "d2bde0b6b2dc8d23342040458315eab71fedebdfc4e278ca1de7255eeac6b7e0",
  },
  {
    id: "color-system:terracotta-clay",
    versionId:
      "f23a7edd4705fcf7b8086da55553a601194bcd857be15de7072128ff916a03ad",
  },
  {
    id: "color-system:warm-sand",
    versionId:
      "e9ea329a25491e347cb3c1156735201a4ff7f8a299dd8990b024d31854b49050",
  },
  {
    id: "template:black-slabs",
    versionId:
      "007c37df08b7a017b52fd40ebf848b14894afe08b45770b1fae06fed7b77c11f",
  },
  {
    id: "template:blueprint-grid",
    versionId:
      "a8904a5dabcd9400d06732f2191ae09b26e4497eaf8628a1d6255977d8ceec01",
  },
  {
    id: "template:coastal-hotel",
    versionId:
      "9f2302ccbbfeb834f1eb7671abe17bf92aa52e2dda63b7cccc0180fa4f07f3d2",
  },
  {
    id: "template:frame-stack",
    versionId:
      "bb6106f6a0a56346dc53a9092a2272334fd77c9159ffff4f46426286d4fbea31",
  },
  {
    id: "template:gallery-wall",
    versionId:
      "2691d0fc64b2cbd711d0678dc12ab34f268f11b11789f8d9956f35fbab3ec01f",
  },
  {
    id: "template:glass-bloom",
    versionId:
      "80d5bd9e80554e1e3e71a970d1c438d0c6def79889dfcd5e5152ad1152f3b91f",
  },
  {
    id: "template:serif-stack",
    versionId:
      "741f16c88c518da56cb2b0322c004a3f9c874ba7c39accf886c8444436f5b421",
  },
  {
    id: "template:sticker-pop",
    versionId:
      "ef6b1b8470785c71be604d06a7eb0afe72092f2d75e4623cb700465d5e436c3f",
  },
  {
    id: "template:warm-cards",
    versionId:
      "2b21bbf11d7d890f9e3b51db16eabff3be958773af41fed0c9163cb3c4ec89fa",
  },
] as const;

function storageNameFor(id: string): string {
  return `registry-resource@${id}`;
}

function findArchiveSha256(id: string): string {
  const entry =
    findSkill(id) ??
    findTool(id) ??
    findTemplate(id) ??
    findDesignSystem(id) ??
    findColorSystem(id) ??
    findPresentationRunbookResource(id) ??
    findWebsiteTemplateResource(id);
  const sha256 = entry?.source.archive?.sha256;
  if (!sha256) {
    throw new Error(`missing archive sha for ${id}`);
  }
  return sha256;
}

function client() {
  return setupApp({ context })(registryResourceDownloadContract);
}

function authHeaders() {
  routeMocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  return { authorization: "Bearer clerk-session" };
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

describe("registry resource download", () => {
  it.each(PRIVATE_ARCHIVE_FIXTURES)(
    "returns a presigned URL for allowlisted private registry archive $id",
    async (fixture) => {
      const { s3Key } = await seedRegistryArchiveStorage({
        storageName: storageNameFor(fixture.id),
        versionId: fixture.versionId,
        size: 1_433_248,
        fileCount: 19,
      });
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", "test-user-storages");
      context.mocks.s3.getSignedUrl.mockResolvedValue(
        "https://r2.example.test/private-resource.tar.gz?sig=test",
      );

      const response = await accept(
        client().download({
          headers: authHeaders(),
          query: { id: fixture.id },
        }),
        [200],
      );

      expect(response.body).toMatchObject({
        id: fixture.id,
        type: "tar.gz",
        sha256: findArchiveSha256(fixture.id),
        versionId: fixture.versionId,
        fileCount: 19,
        size: 1_433_248,
        expiresInSeconds: 900,
        url: "https://r2.example.test/private-resource.tar.gz?sig=test",
      });

      const [, command] = context.mocks.s3.getSignedUrl.mock.calls.at(-1) ?? [];
      expect(commandInput(command)).toMatchObject({
        Bucket: "test-user-storages",
        Key: `${s3Key}/archive.tar.gz`,
      });
    },
  );

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
