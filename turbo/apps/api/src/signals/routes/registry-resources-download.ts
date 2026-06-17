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
