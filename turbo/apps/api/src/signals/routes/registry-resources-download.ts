import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findSkill,
  findTemplate,
  findTool,
  findVideoTemplate,
  type RegistryEntry,
  type VideoTemplateRegistryEntry,
} from "@vm0/core/resource-registry";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";
import type { RouteEntry } from "../route";

type PullableRegistryEntry = RegistryEntry | VideoTemplateRegistryEntry;

interface PrivateRegistryResourceArchive {
  readonly storageName: string;
  readonly versionId: string;
}

const DOWNLOAD_URL_TTL_SECONDS = 900;

function storageServiceNotConfigured() {
  return {
    status: 500 as const,
    body: {
      error: {
        message: "Storage service is not properly configured",
        code: "INTERNAL_ERROR" as const,
      },
    },
  };
}

const PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS = {
  "tool:presentation-deck-tools":
    "610da333cd83b2d5d5901316638f5f2ee625058e529ccb8100cd87e489c6a030",
  "design-system:business-data":
    "c9f7a6246c31da8a50f8e0bedee769416af83fdea4047ec59ccf926b78f18fe9",
  "design-system:botane-organic":
    "056382cf6a8b8667b09ba7db8f994d903b3c53a00e0e9cfab281f58ee185df52",
  "design-system:playful-editorial":
    "4e521d00ce64504386ed6b90fb8631224bc7975152085fa968a70a456ae8de02",
  "design-system:crayon":
    "2aa846c47ae074ec3877be4e53011ffdad035110ef5b06cd1e3b86dc68200bf4",
  "design-system:creative-agency":
    "2c9b61a5a5147877f30a6e59d0acab849091a6671d0d8109e26b951b52f76e35",
  "design-system:data-report":
    "80fa6a922a559146071f7186306e7464af3457c2afe22458db038637314bdad1",
  "design-system:editorial-magazine":
    "87eac1a9f8b5e442e9b693025cfa4c766b41f72ef4cb41ca10f55bdaf7415781",
  "design-system:landing-consulting":
    "45b32ec98c3c1a8ecff7505beef0219994951c66f725e07e48a014401e7cd7d6",
  "design-system:lumina":
    "4bf2d81a44a3abe26449296d12f8321292603387d647e6337082085407d844b2",
  "design-system:mosaic-geometric":
    "42850801add7bff2d66fa34434fa48c01b53aedbe4e14146c23e017659905dde",
  "design-system:playful-pop":
    "f54ec75c03c6f1a4722cc84429c521fe7758e15402de22f8cf842b6c715db524",
  "design-system:nocturne":
    "2344d4eeb97b8706148f6fabe7e73973a98a9d9929be31f7a4e531a3136bbb2b",
  "design-system:neo-brutalism":
    "929a4c72074e3fce2b64b16c5f53507707225dc71e5909d86b5f9a1bc43c2da0",
  "design-system:bloom-pitch":
    "951db59508b46f5f483f0b8dc4c1488d12b9977cd182644904ebfb7d53f4a795",
  "design-system:blueprint-academy":
    "519cb8a9866664072e27b380800b4749bd2c2b2bcd2a87c1b6b45771dd4b803c",
  "design-system:meridian":
    "e4b07b5b5d837481ca3025e4e47d04fc1565cf5cd86dc55471eff387e86c70c1",
  "design-system:pixel-glitch":
    "9906a37702544ac949dece9b83eb40139a94bceda4fc18eea73828e9a8cc561b",
  "design-system:prospectus":
    "319f03a0df3a07039c1ef10fbc6663173c3eefcfa3f90b25f8ff08d7dde39870",
  "design-system:schoolhouse":
    "66ceb17d376190beeb523d406eb645c5e12fd268e005e4d49c7f2b0293a9f2b7",
  "design-system:sticker-scrapbook":
    "0d0af81dec7322f7826c65734077e2fa5acfc63caf78055b202579bc6f309184",
  "design-system:strata":
    "4c5fd8631f88b0f5fb68983d6897f7f9a87ee58a5c292e5b09a08dc13a58fb6f",
  "design-system:taped-consulting":
    "c33b3421a9108798a4626b7aeb9f3a8e48593b7b268ffa300df41f49c41cd9a3",
  "design-system:vantage":
    "0c153dc7f1106422bac7a217fef107b16f69e8672a51819a8f3d1173b5c22a33",
  "color-system:bauhaus-primary":
    "26c34a2a33a5c7b751b6741da5e4013020d5dbe138e60f5b3a444f4a5d3a351b",
  "color-system:berry-pop":
    "a9e00d18e3042262affb0d1396bd010aa8fa548f6b89e8ae1d634aec37a955b7",
  "color-system:carnival":
    "112848d050081ddca2d8ffc57a685906998a7073ddd7585cc4d94f9060b439b8",
  "color-system:citrus-fresh":
    "556f9d77f9aa835475b423639e8d642f6e63d5c66f7a4b5b954a37c058292b30",
  "color-system:coral-studio":
    "15103787a715de87210ed905a7e35e76694a7a33f3c1a2d734ea54239fba1280",
  "color-system:forest-editorial":
    "24cc3c0b4062114e877221d0f50bde4de00c90838d7a54f6013c9038bdd2e19d",
  "color-system:gold-luxe":
    "b4c5af7c9bddc8ef1e47d681fadd678852f3b4dc7a9eafd749eca54ba60acbe7",
  "color-system:mauve-dusk":
    "181f5d2ee8dfd765563b891693dc145f77a313013f788c799bfefadc231bbcf8",
  "color-system:midnight-mono":
    "a9cfc3533f23d04b48e7270a45f4577c5e055509bad35118a23a14ad8c52345b",
  "color-system:mint-tech":
    "19bf57aae59ef94b0cb18dcfed6d5ab6d55b3d38f7196c704e9301351820db8d",
  "color-system:mono-ink":
    "cc135f036e03e30773d2e01739ed93e0b578f501f44019114e4674bd6a05d932",
  "color-system:nordic-frost":
    "a1b0f1018d46dabfb004c933f6a557b43498e8c957e8d5fe1375ab8d1699a9aa",
  "color-system:ocean-deep":
    "c848d3aac65c0c9a8f749c61a5aad5f634cf5d7d75d78f1080a45530d3bfdc78",
  "color-system:pop-art":
    "82d9330442d86f9969748acf12fd964e9999cad0089b441f57df708cf43ccf79",
  "color-system:prism":
    "45c23078172e802ed40e81922b072407bb6a19bf839d5e5be2431d30cc9190c9",
  "color-system:slate-corporate":
    "c082c9a8e96aa2c29720e8b06eb827d56f10b0fa5db05112f65cd3a251b65b49",
  "color-system:sunset-maroon":
    "d2bde0b6b2dc8d23342040458315eab71fedebdfc4e278ca1de7255eeac6b7e0",
  "color-system:terracotta-clay":
    "f23a7edd4705fcf7b8086da55553a601194bcd857be15de7072128ff916a03ad",
  "color-system:warm-sand":
    "e9ea329a25491e347cb3c1156735201a4ff7f8a299dd8990b024d31854b49050",
  "template:html-ppt-botane-organic":
    "7438cf79bbf25501de0c7a91cc35a98e164e6e1e59c8e8571f0f2d4272a5158f",
  "template:html-ppt-playful-launch":
    "ff2dae6ef1f99d1c754903a7acc49ea220a5439f7408870f8a9074e4543de190",
  "template:html-ppt-business-data":
    "dd820c04b1c913413555adc8402a759abad8da2f6e80dd8add8a2a5120249d1b",
  "template:html-ppt-crayon":
    "23ee8a977f4e437c2ef5e82236822b5bb687077951fc2fa375de3b48b79bb205",
  "template:html-ppt-creative-agency":
    "e8c07a3b33c3edd7dd64693890be854a45fec0b2cf6edece53108472e2a076aa",
  "template:html-ppt-data-report":
    "ecb1617127e5626726790b7e248722e2e0a81592413aa7a98a7da640649ece08",
  "template:html-ppt-editorial-magazine":
    "ef93ddbd125dd9e85f060f61afe7eda17cc26560a0f436eafaa422fb5ad8f6a1",
  "template:html-ppt-landing-consulting":
    "fa1f402e0b2c9e071a17cfebe547b11537030be066d4bbf04b1374678ec06d4d",
  "template:html-ppt-lumina":
    "a39fcc27d8f5d6a712959cfccf1cb930627faa8877b8d990439ad9679adc4c5f",
  "template:html-ppt-mosaic-geometric":
    "3a09001e9455d10e96d9cbfd6dc66c2705cb26b7bdc41a9764cb8a20f65d74b1",
  "template:html-ppt-playful-pop":
    "6c5a931e683b359c5c8561aeda0b34f5b784da052b051d2e2cb2f155aae20097",
  "template:html-ppt-nocturne":
    "b0bb3ef5e0fcc772ecfa67e27776e3be38fdff33b411b431d053544b5ffa4abc",
  "template:html-ppt-neo-brutalism":
    "8d3ff7b69bbc1ec197f60688d92ffddf5fd5d3c3186aa69cce35d49ce057514c",
  "template:html-ppt-bloom-pitch":
    "381d52c641588675a939612b71a7e4b37dcc2ac2bfa55f7d73c5b3a635a53175",
  "template:html-ppt-blueprint-academy":
    "551ccd097862ab360d3d9125f2113cf68e1aa91fd1e4748eb64617638433d03c",
  "template:html-ppt-meridian":
    "f07842290d44056fe0781a21de47528fe67ae32aaf62b5a53a2c590432343a83",
  "template:html-ppt-pixel-glitch":
    "1c576e8851cdc4b57c4ed1c84415b52137efcd965c981f194c4ee910f7d42ccb",
  "template:html-ppt-prospectus":
    "e628f268e2c2983e84e21154e4afe0747552cc0457069ff2913e1c360ef7d47a",
  "template:html-ppt-schoolhouse":
    "6151e85d2e94d26dce77c987765db5a67038c9a1d30dc3ce9e7c74847605eb31",
  "template:html-ppt-sticker-scrapbook":
    "30c2a72e7f058f3c4fe2e63fa60b8bdc6124565461fbbb11ff6c113a406faf66",
  "template:html-ppt-strata":
    "ca499dce027b3f063da0980154137ebd6a3ee4aeb9c4ae6eeeb7140303a7c05f",
  "template:html-ppt-taped-consulting":
    "8323a7a66d1a63c50f8ff81b9b3ce5505225afbc1cafd3d2786642a9dce2b426",
  "template:html-ppt-vantage":
    "443945f5416488feea43cf0cb8f005046a289fbceb8a2c214ba72bd93f31de32",
} as const satisfies Record<string, string>;

function privateRegistryResourceArchive(
  id: string,
): PrivateRegistryResourceArchive | undefined {
  const versionId =
    PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS[
      id as keyof typeof PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS
    ];
  if (!versionId) {
    return undefined;
  }

  return {
    storageName: `registry-resource@${id}`,
    versionId,
  };
}

function findRegistryResource(id: string): PullableRegistryEntry | undefined {
  return (
    findSkill(id) ??
    findTool(id) ??
    findTemplate(id) ??
    findDesignSystem(id) ??
    findColorSystem(id) ??
    findImageStyle(id) ??
    findVideoTemplate(id)
  );
}

function archiveFilename(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`;
}

const downloadRegistryResourceInner$ = computed(async (get) => {
  const query = get(queryOf(registryResourceDownloadContract.download));
  const privateArchive = privateRegistryResourceArchive(query.id);
  if (!privateArchive) {
    return notFound(`Registry resource "${query.id}" is not private-pullable`);
  }

  const entry = findRegistryResource(query.id);
  const archive = entry?.source.archive;
  if (!entry || !archive) {
    return notFound(`Registry resource "${query.id}" has no archive source`);
  }

  const db = get(db$);
  const [version] = await db
    .select({
      s3Key: storageVersions.s3Key,
      fileCount: storageVersions.fileCount,
      size: storageVersions.size,
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storages.id, storageVersions.storageId))
    .where(
      and(
        eq(storages.name, privateArchive.storageName),
        eq(storages.type, "volume"),
        eq(storageVersions.id, privateArchive.versionId),
      ),
    )
    .limit(1);

  if (!version) {
    return notFound(`Private archive for "${query.id}" was not found`);
  }

  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  if (!bucket) {
    return storageServiceNotConfigured();
  }

  const url = await get(
    generatePresignedGetUrl(
      bucket,
      `${version.s3Key}/archive.tar.gz`,
      DOWNLOAD_URL_TTL_SECONDS,
      archiveFilename(query.id),
      true,
    ),
  );

  return {
    status: 200 as const,
    body: {
      url,
      id: entry.id,
      type: archive.type,
      sha256: archive.sha256,
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
      versionId: privateArchive.versionId,
      fileCount: version.fileCount,
      size: Number(version.size),
    },
  };
});

export const registryResourceDownloadRoutes: readonly RouteEntry[] = [
  {
    route: registryResourceDownloadContract.download,
    handler: authRoute(
      { requiredCapability: "file:read" },
      downloadRegistryResourceInner$,
    ),
  },
];
