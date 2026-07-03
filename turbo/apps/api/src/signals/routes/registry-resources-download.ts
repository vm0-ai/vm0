import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findPresentationRunbookResource,
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
import type { RouteEntry } from "../route-entry";

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
    "3c4f3323dcf5d8a03a9780c3a46906706efbdc9f845d50c0d882e05d5ff1828f",
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
  // Presentation runbook packages (self-contained per-template archives).
  "template:html-ppt-playful-launch-runbook":
    "1c46e7d953de0ea47924b9e9936433d7ede1d21ac595f62cbcdee160bded6c26",
  "template:html-ppt-bloom-pitch-runbook":
    "58cf8db8aa23176e9290719ae567f639dcb1c5bd7058a580a4d01f4ce1d3fdf5",
  "template:html-ppt-blueprint-academy-runbook":
    "69536f28d581fced0512e5f61195b32aa4e80a260f14e953abb9710c17d7aef3",
  "template:html-ppt-botane-organic-runbook":
    "9c5886408f471e4939e8d17e75ab085647ca4fb6d4f0b8f878ea52fd3138f1f8",
  "template:html-ppt-business-data-runbook":
    "708cfa85ffc746c400e8200d248fd3674c1b41d955a19c5d29c76b55e12c2ae9",
  "template:html-ppt-crayon-runbook":
    "dfaf1f0bce54497e476e51923495d6a8d7be46c895c1b62f784910d876e2ddba",
  "template:html-ppt-creative-agency-runbook":
    "543d15a486b8b4dd588ae3f5a75b363b62e4f9cef12254f6b21c3eeb6075739f",
  "template:html-ppt-data-report-runbook":
    "9153793baa7a1fbd114faafdde113292b2fea124471a905b7347eb53400de413",
  "template:html-ppt-editorial-magazine-runbook":
    "c76af4a6b696bae7afb35b5909188553d766b1f2a49212c55ff22e7e0f99a4a6",
  "template:html-ppt-landing-consulting-runbook":
    "1fe914f9ba1438deb3ebab86c17721474eada19243e08d4769954fde5d16e830",
  "template:html-ppt-lumina-runbook":
    "b3f4732414f67862b0aa17415b2af0d5bdd92fd4779b386964efa59402409fa0",
  "template:html-ppt-meridian-runbook":
    "d67ea5a3225c96289327bc64ec76e37e4e66bbbc977d212d8e046d42387ca81d",
  "template:html-ppt-mosaic-geometric-runbook":
    "5f3a99097a5e7fdf3f206e537f5af156aa73c2f9af0ff8a2d6d70336c074d550",
  "template:html-ppt-neo-brutalism-runbook":
    "364c85728bd3965c78a8126da2c756930bfcec0999145774efff4b3b67a4dc62",
  "template:html-ppt-nocturne-runbook":
    "f713d74d5845a39bbdac672ff47baa3558d3e5e248465dd644ba951322445aab",
  "template:html-ppt-pixel-glitch-runbook":
    "c966b28b3024528e99c814c0fef998d1331294472a3ee2c3dccc7f68ba76b33d",
  "template:html-ppt-playful-pop-runbook":
    "a9e31045b0eebe35b32d3d22f2d866d45394d79b99e805e2cae03fcb04282cc0",
  "template:html-ppt-prospectus-runbook":
    "69e3c21d3ff27ebdd5ee6079e2809e9f7e7a0a1d6ba673349d957a961798f36b",
  "template:html-ppt-schoolhouse-runbook":
    "a34ed3483769cc2825656849385b86f23c50e5500d8ab20e7a705019949e49a5",
  "template:html-ppt-sticker-scrapbook-runbook":
    "3b8eae68d6ff1dbb90396b0e929e9adc88dcb8c1850a6e7dbf13b650beb279bc",
  "template:html-ppt-strata-runbook":
    "480717095fda024858014262a77e95344cf2f2f319603eb3f295662bc3ec43cc",
  "template:html-ppt-taped-consulting-runbook":
    "423c53c83c3f7a4b3ca9c6f9ce314b8bec4555cf2497a0fcc9fbd20c36a13acb",
  "template:html-ppt-vantage-runbook":
    "366c1c2028815fcb13b4c8798550ded9e0853cf55fd2df9124ab4327ff012362",
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
    findVideoTemplate(id) ??
    findPresentationRunbookResource(id)
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
