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
      "82cf61753b7e7d81cf2c457ea1ac970b266dcbec8b2d253d462b7dd035843e87",
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
      "5f89b454969ac0ba0bb6417be0b42b3ff9e0dbe0af7cf832d51d9dc198f34bcf",
  },
  {
    id: "template:html-ppt-playful-launch",
    versionId:
      "ab66ed71a98e114679b6e3bd1fe61c160837c5197cc69ddd0d6c737b56ab0ac8",
  },
  {
    id: "template:html-ppt-business-data",
    versionId:
      "2a8c81df0e0f5acb2cd703816a4156a3e51d02b9e9bc60563331853569d85f35",
  },
  {
    id: "design-system:crayon",
    versionId:
      "2aa846c47ae074ec3877be4e53011ffdad035110ef5b06cd1e3b86dc68200bf4",
  },
  {
    id: "template:html-ppt-crayon",
    versionId:
      "d49deba891ffbd2b7ba767dd94451863ba4f36138819b15a47b762011cc8e04c",
  },
  {
    id: "design-system:creative-agency",
    versionId:
      "2c9b61a5a5147877f30a6e59d0acab849091a6671d0d8109e26b951b52f76e35",
  },
  {
    id: "template:html-ppt-creative-agency",
    versionId:
      "6f9672390e3f7f27a355ad5e6d96ec0f9e45f31bb92a36faaff02a8d5b7cae24",
  },
  {
    id: "design-system:data-report",
    versionId:
      "80fa6a922a559146071f7186306e7464af3457c2afe22458db038637314bdad1",
  },
  {
    id: "template:html-ppt-data-report",
    versionId:
      "d0cef7bb7d9352b9bcff11c60b27edd39d230eac833736b0c97f79657f38020d",
  },
  {
    id: "design-system:editorial-magazine",
    versionId:
      "87eac1a9f8b5e442e9b693025cfa4c766b41f72ef4cb41ca10f55bdaf7415781",
  },
  {
    id: "template:html-ppt-editorial-magazine",
    versionId:
      "09cb5911f7c6dc84e9c55220954d590de5a94bba3e197413f7054f5859b07f47",
  },
  {
    id: "design-system:landing-consulting",
    versionId:
      "45b32ec98c3c1a8ecff7505beef0219994951c66f725e07e48a014401e7cd7d6",
  },
  {
    id: "template:html-ppt-landing-consulting",
    versionId:
      "7be41feb6a0c1a41a9a45d9f62233bcb8a8c340e2977079aa2e19de685b3e09a",
  },
  {
    id: "design-system:lumina",
    versionId:
      "4bf2d81a44a3abe26449296d12f8321292603387d647e6337082085407d844b2",
  },
  {
    id: "template:html-ppt-lumina",
    versionId:
      "c00e7b7f2196705f2cbfcdb8ae67050f74e16523698b495b80e2aacea890084f",
  },
  {
    id: "design-system:mosaic-geometric",
    versionId:
      "42850801add7bff2d66fa34434fa48c01b53aedbe4e14146c23e017659905dde",
  },
  {
    id: "template:html-ppt-mosaic-geometric",
    versionId:
      "d43e78bca6dd3a83082cd11a6e1f1f25b4f917bc476e65bb61d7d35a02e28865",
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
      "e4f602af8e90d4070a532f32db797d563952d2dfce7743e804224cfd13e591e8",
  },
  {
    id: "design-system:neo-brutalism",
    versionId:
      "929a4c72074e3fce2b64b16c5f53507707225dc71e5909d86b5f9a1bc43c2da0",
  },
  {
    id: "template:html-ppt-neo-brutalism",
    versionId:
      "d208161627b8a737fdaa0aa0d2eea1b04296f39ec14c7b6d8f2fd4c7875f24a9",
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
      "5bb98f6e726afedab710886dc9289d7f96a3045a1a907182f7c018be28e0f82a",
  },
  {
    id: "template:html-ppt-blueprint-academy",
    versionId:
      "b14af02df9ae609667a3c22874d6beeba55fef63c06f10f712574ffb730cc644",
  },
  {
    id: "template:html-ppt-meridian",
    versionId:
      "135f0291ad3c0573589fc425a69b39ead5d7ffc61fa5d9dc15e14d3ae67cf842",
  },
  {
    id: "template:html-ppt-pixel-glitch",
    versionId:
      "c99d1ec84c987a30d65cf1e4507adc230aa6e0467784f5a8ec69eef433274add",
  },
  {
    id: "template:html-ppt-prospectus",
    versionId:
      "ad08b7e58d64c584a54a7292c42c800dce6f3ed9049bbdc0991a88ad9393a169",
  },
  {
    id: "template:html-ppt-schoolhouse",
    versionId:
      "9c997ff8babbf3189b2580a0d4c0d2c65ff04235b3e34a6a6b2ca4d4d951cba3",
  },
  {
    id: "template:html-ppt-sticker-scrapbook",
    versionId:
      "38f73f5cf435233f9baa0ea67f2e73258947bf6b5a36f90cea5ae98b194ef40a",
  },
  {
    id: "template:html-ppt-strata",
    versionId:
      "fcfe92b3de8aa4ba5f69ab2327766137c49730d07a79a1627a7a838bbefe8859",
  },
  {
    id: "template:html-ppt-taped-consulting",
    versionId:
      "b4639811099781c662a9671126762c67c1cc726e7a545b7bfbed18032faace9b",
  },
  {
    id: "template:html-ppt-vantage",
    versionId:
      "93e9a05f8c9c7f5ad99b51b1b9dae87a16d026782458edcfa629a514242de3f6",
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
      "80a15eda37a303768ccee897c81c0bcd9d265c0a377b34ce92a127951f8d0787",
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
