import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
  findColorSystem,
  findDesignSystem,
  findSkill,
  findTemplate,
  findTool,
} from "@vm0/core/resource-registry";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const routeMocks = createZeroRouteMocks(context);

const PRIVATE_ARCHIVE_FIXTURES = [
  {
    id: "tool:presentation-deck-tools",
    versionId:
      "b6ea3b108cb3d710306766fbd75eac537283b166a9a5c5345a0bb884f9af3606",
  },
  {
    id: "design-system:business-data",
    versionId:
      "c9f7a6246c31da8a50f8e0bedee769416af83fdea4047ec59ccf926b78f18fe9",
  },
  {
    id: "design-system:botane-organic",
    versionId:
      "056382cf6a8b8667b09ba7db8f994d903b3c53a00e0e9cfab281f58ee185df52",
  },
  {
    id: "design-system:playful-editorial",
    versionId:
      "4e521d00ce64504386ed6b90fb8631224bc7975152085fa968a70a456ae8de02",
  },
  {
    id: "template:html-ppt-botane-organic",
    versionId:
      "9006d9269fc2062a7495c9b16ff44ca114893ecfbccf44b61fd15cbff285e084",
  },
  {
    id: "template:html-ppt-playful-launch",
    versionId:
      "0ead582418a76f734c609b792fc85d747c636029938210129d55ce912d7711f6",
  },
  {
    id: "template:html-ppt-business-data",
    versionId:
      "57a1072b1c5e045c260de7e9d40c0b8836a3b3239d42873597433f1d77925305",
  },
  {
    id: "design-system:crayon",
    versionId:
      "2aa846c47ae074ec3877be4e53011ffdad035110ef5b06cd1e3b86dc68200bf4",
  },
  {
    id: "template:html-ppt-crayon",
    versionId:
      "7991ad80f051da3d1715f3f1c10c3bf61de69f7746b5a8c67d655c13f6057119",
  },
  {
    id: "design-system:creative-agency",
    versionId:
      "2c9b61a5a5147877f30a6e59d0acab849091a6671d0d8109e26b951b52f76e35",
  },
  {
    id: "template:html-ppt-creative-agency",
    versionId:
      "97bb467bff00a2b9b6c3e9a2ca2b633d9993937de58c10ce2d5f3a7cd372f86b",
  },
  {
    id: "design-system:data-report",
    versionId:
      "80fa6a922a559146071f7186306e7464af3457c2afe22458db038637314bdad1",
  },
  {
    id: "template:html-ppt-data-report",
    versionId:
      "37cf5cfefa5a03a9e420a09dec3e180fd8160ee4375e76d8e24940e6fb166fe7",
  },
  {
    id: "design-system:editorial-magazine",
    versionId:
      "87eac1a9f8b5e442e9b693025cfa4c766b41f72ef4cb41ca10f55bdaf7415781",
  },
  {
    id: "template:html-ppt-editorial-magazine",
    versionId:
      "1d6ef172bff161ad705877b12ba3b6419d317e8810b42f0ef6c9312fc38d2b99",
  },
  {
    id: "design-system:landing-consulting",
    versionId:
      "45b32ec98c3c1a8ecff7505beef0219994951c66f725e07e48a014401e7cd7d6",
  },
  {
    id: "template:html-ppt-landing-consulting",
    versionId:
      "621b5383d04b3d6214e9b12423cedf23900ddb07cae2e90b80937b2b662a668c",
  },
  {
    id: "design-system:lumina",
    versionId:
      "4bf2d81a44a3abe26449296d12f8321292603387d647e6337082085407d844b2",
  },
  {
    id: "template:html-ppt-lumina",
    versionId:
      "31a7d9abd766a12851a1e0f5b2ac09f08d31f5cf469fa4f8f2f5b1835892bebb",
  },
  {
    id: "design-system:mosaic-geometric",
    versionId:
      "42850801add7bff2d66fa34434fa48c01b53aedbe4e14146c23e017659905dde",
  },
  {
    id: "template:html-ppt-mosaic-geometric",
    versionId:
      "bd2ca98aba4e61281c7b431d1dd042fa26783b32196d993101861fbb2648a307",
  },
  {
    id: "design-system:playful-pop",
    versionId:
      "f54ec75c03c6f1a4722cc84429c521fe7758e15402de22f8cf842b6c715db524",
  },
  {
    id: "design-system:nocturne",
    versionId:
      "2344d4eeb97b8706148f6fabe7e73973a98a9d9929be31f7a4e531a3136bbb2b",
  },
  {
    id: "template:html-ppt-nocturne",
    versionId:
      "975042cc63adf2ec5a6c7888a541807571579959e7da6af7681038c4352c4d7f",
  },
  {
    id: "design-system:neo-brutalism",
    versionId:
      "929a4c72074e3fce2b64b16c5f53507707225dc71e5909d86b5f9a1bc43c2da0",
  },
  {
    id: "template:html-ppt-neo-brutalism",
    versionId:
      "14216859630a1ba018c7e4c85b26452e450b10a187ac44d13b1e0d0b6407977f",
  },
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
    id: "template:html-ppt-playful-pop",
    versionId:
      "9e8d84ec293962f6162b4ce609d849d5c61645f4894240e2a1fa3f6d6e179aec",
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
    findColorSystem(id);
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

async function deleteStorageFixture(storageName: string): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(storages).where(eq(storages.name, storageName));
}

async function deleteStorageFixtures(): Promise<void> {
  for (const fixture of PRIVATE_ARCHIVE_FIXTURES) {
    await deleteStorageFixture(storageNameFor(fixture.id));
  }
}

async function seedPrivateArchiveStorage(
  fixture: (typeof PRIVATE_ARCHIVE_FIXTURES)[number],
): Promise<string> {
  const writeDb = store.set(writeDb$);
  const storageName = storageNameFor(fixture.id);
  await deleteStorageFixture(storageName);

  const orgId = `org_${randomUUID()}`;
  const s3Prefix = `${orgId}/volume/${storageName}`;
  const s3Key = `${s3Prefix}/${fixture.versionId}`;
  const [storage] = await writeDb
    .insert(storages)
    .values({
      orgId,
      userId: VOLUME_ORG_USER_ID,
      name: storageName,
      type: "volume",
      s3Prefix,
      size: 1_433_248,
      fileCount: 19,
    })
    .returning({ id: storages.id });

  if (!storage) {
    throw new Error("Failed to seed registry resource storage");
  }

  await writeDb.insert(storageVersions).values({
    id: fixture.versionId,
    storageId: storage.id,
    s3Key,
    size: 1_433_248,
    fileCount: 19,
    message: "test private registry archive",
    createdBy: "test",
  });
  await writeDb
    .update(storages)
    .set({ headVersionId: fixture.versionId })
    .where(eq(storages.id, storage.id));

  return s3Key;
}

afterEach(async () => {
  await deleteStorageFixtures();
});

describe("registry resource download", () => {
  it.each(PRIVATE_ARCHIVE_FIXTURES)(
    "returns a presigned URL for allowlisted private registry archive $id",
    async (fixture) => {
      const s3Key = await seedPrivateArchiveStorage(fixture);
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
