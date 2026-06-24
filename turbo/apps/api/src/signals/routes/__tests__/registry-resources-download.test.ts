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
      "610da333cd83b2d5d5901316638f5f2ee625058e529ccb8100cd87e489c6a030",
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
      "7438cf79bbf25501de0c7a91cc35a98e164e6e1e59c8e8571f0f2d4272a5158f",
  },
  {
    id: "template:html-ppt-playful-launch",
    versionId:
      "ff2dae6ef1f99d1c754903a7acc49ea220a5439f7408870f8a9074e4543de190",
  },
  {
    id: "template:html-ppt-business-data",
    versionId:
      "dd820c04b1c913413555adc8402a759abad8da2f6e80dd8add8a2a5120249d1b",
  },
  {
    id: "design-system:crayon",
    versionId:
      "2aa846c47ae074ec3877be4e53011ffdad035110ef5b06cd1e3b86dc68200bf4",
  },
  {
    id: "template:html-ppt-crayon",
    versionId:
      "23ee8a977f4e437c2ef5e82236822b5bb687077951fc2fa375de3b48b79bb205",
  },
  {
    id: "design-system:creative-agency",
    versionId:
      "2c9b61a5a5147877f30a6e59d0acab849091a6671d0d8109e26b951b52f76e35",
  },
  {
    id: "template:html-ppt-creative-agency",
    versionId:
      "e8c07a3b33c3edd7dd64693890be854a45fec0b2cf6edece53108472e2a076aa",
  },
  {
    id: "design-system:data-report",
    versionId:
      "80fa6a922a559146071f7186306e7464af3457c2afe22458db038637314bdad1",
  },
  {
    id: "template:html-ppt-data-report",
    versionId:
      "ecb1617127e5626726790b7e248722e2e0a81592413aa7a98a7da640649ece08",
  },
  {
    id: "design-system:editorial-magazine",
    versionId:
      "87eac1a9f8b5e442e9b693025cfa4c766b41f72ef4cb41ca10f55bdaf7415781",
  },
  {
    id: "template:html-ppt-editorial-magazine",
    versionId:
      "ef93ddbd125dd9e85f060f61afe7eda17cc26560a0f436eafaa422fb5ad8f6a1",
  },
  {
    id: "design-system:landing-consulting",
    versionId:
      "45b32ec98c3c1a8ecff7505beef0219994951c66f725e07e48a014401e7cd7d6",
  },
  {
    id: "template:html-ppt-landing-consulting",
    versionId:
      "fa1f402e0b2c9e071a17cfebe547b11537030be066d4bbf04b1374678ec06d4d",
  },
  {
    id: "design-system:lumina",
    versionId:
      "4bf2d81a44a3abe26449296d12f8321292603387d647e6337082085407d844b2",
  },
  {
    id: "template:html-ppt-lumina",
    versionId:
      "a39fcc27d8f5d6a712959cfccf1cb930627faa8877b8d990439ad9679adc4c5f",
  },
  {
    id: "design-system:mosaic-geometric",
    versionId:
      "42850801add7bff2d66fa34434fa48c01b53aedbe4e14146c23e017659905dde",
  },
  {
    id: "template:html-ppt-mosaic-geometric",
    versionId:
      "3a09001e9455d10e96d9cbfd6dc66c2705cb26b7bdc41a9764cb8a20f65d74b1",
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
      "b0bb3ef5e0fcc772ecfa67e27776e3be38fdff33b411b431d053544b5ffa4abc",
  },
  {
    id: "design-system:neo-brutalism",
    versionId:
      "929a4c72074e3fce2b64b16c5f53507707225dc71e5909d86b5f9a1bc43c2da0",
  },
  {
    id: "template:html-ppt-neo-brutalism",
    versionId:
      "8d3ff7b69bbc1ec197f60688d92ffddf5fd5d3c3186aa69cce35d49ce057514c",
  },
  {
    id: "design-system:bloom-pitch",
    versionId:
      "951db59508b46f5f483f0b8dc4c1488d12b9977cd182644904ebfb7d53f4a795",
  },
  {
    id: "design-system:blueprint-academy",
    versionId:
      "519cb8a9866664072e27b380800b4749bd2c2b2bcd2a87c1b6b45771dd4b803c",
  },
  {
    id: "design-system:meridian",
    versionId:
      "e4b07b5b5d837481ca3025e4e47d04fc1565cf5cd86dc55471eff387e86c70c1",
  },
  {
    id: "design-system:pixel-glitch",
    versionId:
      "9906a37702544ac949dece9b83eb40139a94bceda4fc18eea73828e9a8cc561b",
  },
  {
    id: "design-system:prospectus",
    versionId:
      "319f03a0df3a07039c1ef10fbc6663173c3eefcfa3f90b25f8ff08d7dde39870",
  },
  {
    id: "design-system:schoolhouse",
    versionId:
      "66ceb17d376190beeb523d406eb645c5e12fd268e005e4d49c7f2b0293a9f2b7",
  },
  {
    id: "design-system:sticker-scrapbook",
    versionId:
      "0d0af81dec7322f7826c65734077e2fa5acfc63caf78055b202579bc6f309184",
  },
  {
    id: "design-system:strata",
    versionId:
      "4c5fd8631f88b0f5fb68983d6897f7f9a87ee58a5c292e5b09a08dc13a58fb6f",
  },
  {
    id: "design-system:taped-consulting",
    versionId:
      "c33b3421a9108798a4626b7aeb9f3a8e48593b7b268ffa300df41f49c41cd9a3",
  },
  {
    id: "design-system:vantage",
    versionId:
      "0c153dc7f1106422bac7a217fef107b16f69e8672a51819a8f3d1173b5c22a33",
  },
  {
    id: "template:html-ppt-bloom-pitch",
    versionId:
      "381d52c641588675a939612b71a7e4b37dcc2ac2bfa55f7d73c5b3a635a53175",
  },
  {
    id: "template:html-ppt-blueprint-academy",
    versionId:
      "551ccd097862ab360d3d9125f2113cf68e1aa91fd1e4748eb64617638433d03c",
  },
  {
    id: "template:html-ppt-meridian",
    versionId:
      "f07842290d44056fe0781a21de47528fe67ae32aaf62b5a53a2c590432343a83",
  },
  {
    id: "template:html-ppt-pixel-glitch",
    versionId:
      "1c576e8851cdc4b57c4ed1c84415b52137efcd965c981f194c4ee910f7d42ccb",
  },
  {
    id: "template:html-ppt-prospectus",
    versionId:
      "e628f268e2c2983e84e21154e4afe0747552cc0457069ff2913e1c360ef7d47a",
  },
  {
    id: "template:html-ppt-schoolhouse",
    versionId:
      "6151e85d2e94d26dce77c987765db5a67038c9a1d30dc3ce9e7c74847605eb31",
  },
  {
    id: "template:html-ppt-sticker-scrapbook",
    versionId:
      "30c2a72e7f058f3c4fe2e63fa60b8bdc6124565461fbbb11ff6c113a406faf66",
  },
  {
    id: "template:html-ppt-strata",
    versionId:
      "ca499dce027b3f063da0980154137ebd6a3ee4aeb9c4ae6eeeb7140303a7c05f",
  },
  {
    id: "template:html-ppt-taped-consulting",
    versionId:
      "8323a7a66d1a63c50f8ff81b9b3ce5505225afbc1cafd3d2786642a9dce2b426",
  },
  {
    id: "template:html-ppt-vantage",
    versionId:
      "443945f5416488feea43cf0cb8f005046a289fbceb8a2c214ba72bd93f31de32",
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
      "6c5a931e683b359c5c8561aeda0b34f5b784da052b051d2e2cb2f155aae20097",
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
