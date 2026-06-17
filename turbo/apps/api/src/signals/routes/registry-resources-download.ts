import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
  findDesignSystem,
  findImageStyle,
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

function privateRegistryResourceArchive(
  id: string,
): PrivateRegistryResourceArchive | undefined {
  switch (id) {
    case "design-system:berry-pop": {
      return {
        storageName: "registry-resource@design-system:berry-pop",
        versionId:
          "8a7b9e507e793d31f5d97a126a2eb1e65d7faf299dbdc802ecf1a7e3b88ec4df",
      };
    }
    case "design-system:mauve-dusk": {
      return {
        storageName: "registry-resource@design-system:mauve-dusk",
        versionId:
          "83f12acbb4e377f92f13bc37a203d9111a537237900913233dd7f6ce6bfffa0b",
      };
    }
    case "design-system:playful-editorial": {
      return {
        storageName: "registry-resource@design-system:playful-editorial",
        versionId:
          "4e521d00ce64504386ed6b90fb8631224bc7975152085fa968a70a456ae8de02",
      };
    }
    case "design-system:crayon": {
      return {
        storageName: "registry-resource@design-system:crayon",
        versionId:
          "2aa846c47ae074ec3877be4e53011ffdad035110ef5b06cd1e3b86dc68200bf4",
      };
    }
    case "design-system:creative-agency": {
      return {
        storageName: "registry-resource@design-system:creative-agency",
        versionId:
          "2c9b61a5a5147877f30a6e59d0acab849091a6671d0d8109e26b951b52f76e35",
      };
    }
    case "design-system:data-report": {
      return {
        storageName: "registry-resource@design-system:data-report",
        versionId:
          "80fa6a922a559146071f7186306e7464af3457c2afe22458db038637314bdad1",
      };
    }
    case "design-system:editorial-magazine": {
      return {
        storageName: "registry-resource@design-system:editorial-magazine",
        versionId:
          "87eac1a9f8b5e442e9b693025cfa4c766b41f72ef4cb41ca10f55bdaf7415781",
      };
    }
    case "design-system:landing-consulting": {
      return {
        storageName: "registry-resource@design-system:landing-consulting",
        versionId:
          "45b32ec98c3c1a8ecff7505beef0219994951c66f725e07e48a014401e7cd7d6",
      };
    }
    case "design-system:lumina": {
      return {
        storageName: "registry-resource@design-system:lumina",
        versionId:
          "4bf2d81a44a3abe26449296d12f8321292603387d647e6337082085407d844b2",
      };
    }
    case "design-system:mosaic-geometric": {
      return {
        storageName: "registry-resource@design-system:mosaic-geometric",
        versionId:
          "42850801add7bff2d66fa34434fa48c01b53aedbe4e14146c23e017659905dde",
      };
    }
    case "design-system:playful-pop": {
      return {
        storageName: "registry-resource@design-system:playful-pop",
        versionId:
          "26e0a7900ee895e9efd8aefbb71406a5ac9c0f4065dbb41d19d8688e755bf23b",
      };
    }
    case "template:html-ppt-botane-organic": {
      return {
        storageName: "registry-resource@template:html-ppt-botane-organic",
        versionId:
          "dd38f6ead8da5be5121d285de1f61cde522b3c2eda4d8c3917bea65bf9e852cc",
      };
    }
    case "template:html-ppt-playful-launch": {
      return {
        storageName: "registry-resource@template:html-ppt-playful-launch",
        versionId:
          "debf60cf13d32df7b31fd9078576512257b1a2e1e17b2464cdd17efd6f3638c5",
      };
    }
    case "template:html-ppt-business-data": {
      return {
        storageName: "registry-resource@template:html-ppt-business-data",
        versionId:
          "5d981ea6d44248fdfffb7b467e40177a394f234d5f8ba9b3ff0c33e39d1c7081",
      };
    }
    case "template:html-ppt-crayon": {
      return {
        storageName: "registry-resource@template:html-ppt-crayon",
        versionId:
          "e885701f8ba8947cf37b6ccc999691b7aa4402ad323ad95a5131f27574d913a3",
      };
    }
    case "template:html-ppt-creative-agency": {
      return {
        storageName: "registry-resource@template:html-ppt-creative-agency",
        versionId:
          "6ff526c7dbafe03d535b6638bd385cd807dd1a7cf72fea1f873f45469e8792c7",
      };
    }
    case "template:html-ppt-data-report": {
      return {
        storageName: "registry-resource@template:html-ppt-data-report",
        versionId:
          "c35349b5768d49b2254c354956fac7efa2c956f1095d3631a274e896f319efc7",
      };
    }
    case "template:html-ppt-editorial-magazine": {
      return {
        storageName: "registry-resource@template:html-ppt-editorial-magazine",
        versionId:
          "7a4652c92458d46648df9c05e2c07e155083716ad16327782848b54df5b87eb3",
      };
    }
    case "template:html-ppt-landing-consulting": {
      return {
        storageName: "registry-resource@template:html-ppt-landing-consulting",
        versionId:
          "8eeb740e95d7091996cb60c16d5bb22d084b74fd994b5f56cd13637dc7b9921c",
      };
    }
    case "template:html-ppt-lumina": {
      return {
        storageName: "registry-resource@template:html-ppt-lumina",
        versionId:
          "be61e9c94791814099e110103ffb5f69860a52e8f9a5091e24bc6bdd6d5fe441",
      };
    }
    case "template:html-ppt-mosaic-geometric": {
      return {
        storageName: "registry-resource@template:html-ppt-mosaic-geometric",
        versionId:
          "937aca081fb347504fd4e98127d153a331a2d2595ced3668750e8a3820e6a5ee",
      };
    }
    case "template:html-ppt-playful-pop": {
      return {
        storageName: "registry-resource@template:html-ppt-playful-pop",
        versionId:
          "32927f2b0a559ef47427b573a9a8b35677501bfe0f7366c2d8486dd54365d994",
      };
    }
    default: {
      return undefined;
    }
  }
}

function findRegistryResource(id: string): PullableRegistryEntry | undefined {
  return (
    findTemplate(id) ??
    findDesignSystem(id) ??
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
