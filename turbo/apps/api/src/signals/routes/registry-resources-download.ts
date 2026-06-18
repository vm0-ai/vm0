import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findSkill,
  findTemplate,
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
    "b6ea3b108cb3d710306766fbd75eac537283b166a9a5c5345a0bb884f9af3606",
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
    "9006d9269fc2062a7495c9b16ff44ca114893ecfbccf44b61fd15cbff285e084",
  "template:html-ppt-playful-launch":
    "0ead582418a76f734c609b792fc85d747c636029938210129d55ce912d7711f6",
  "template:html-ppt-business-data":
    "57a1072b1c5e045c260de7e9d40c0b8836a3b3239d42873597433f1d77925305",
  "template:html-ppt-crayon":
    "7991ad80f051da3d1715f3f1c10c3bf61de69f7746b5a8c67d655c13f6057119",
  "template:html-ppt-creative-agency":
    "97bb467bff00a2b9b6c3e9a2ca2b633d9993937de58c10ce2d5f3a7cd372f86b",
  "template:html-ppt-data-report":
    "37cf5cfefa5a03a9e420a09dec3e180fd8160ee4375e76d8e24940e6fb166fe7",
  "template:html-ppt-editorial-magazine":
    "1d6ef172bff161ad705877b12ba3b6419d317e8810b42f0ef6c9312fc38d2b99",
  "template:html-ppt-landing-consulting":
    "621b5383d04b3d6214e9b12423cedf23900ddb07cae2e90b80937b2b662a668c",
  "template:html-ppt-lumina":
    "31a7d9abd766a12851a1e0f5b2ac09f08d31f5cf469fa4f8f2f5b1835892bebb",
  "template:html-ppt-mosaic-geometric":
    "bd2ca98aba4e61281c7b431d1dd042fa26783b32196d993101861fbb2648a307",
  "template:html-ppt-playful-pop":
    "9e8d84ec293962f6162b4ce609d849d5c61645f4894240e2a1fa3f6d6e179aec",
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
