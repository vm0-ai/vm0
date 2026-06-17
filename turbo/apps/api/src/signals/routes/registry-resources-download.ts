import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
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

function privateRegistryResourceArchive(
  id: string,
): PrivateRegistryResourceArchive | undefined {
  switch (id) {
    case "skill:presentation-deck-tools": {
      return {
        storageName: "registry-resource@skill:presentation-deck-tools",
        versionId:
          "a11aab6b73aad5796a77875492564f269d8e4f62c7fbfbf302ab228d43fca5ff",
      };
    }
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
    case "design-system:pop-art": {
      return {
        storageName: "registry-resource@design-system:pop-art",
        versionId:
          "1b1d654c9cc605abe0b7fd230d706a66b72cf4ae9a5951cd743ccc4eff09ee5f",
      };
    }
    case "template:html-ppt-botane-organic": {
      return {
        storageName: "registry-resource@template:html-ppt-botane-organic",
        versionId:
          "9006d9269fc2062a7495c9b16ff44ca114893ecfbccf44b61fd15cbff285e084",
      };
    }
    case "template:html-ppt-playful-launch": {
      return {
        storageName: "registry-resource@template:html-ppt-playful-launch",
        versionId:
          "0ead582418a76f734c609b792fc85d747c636029938210129d55ce912d7711f6",
      };
    }
    case "template:html-ppt-business-data": {
      return {
        storageName: "registry-resource@template:html-ppt-business-data",
        versionId:
          "57a1072b1c5e045c260de7e9d40c0b8836a3b3239d42873597433f1d77925305",
      };
    }
    case "template:html-ppt-crayon": {
      return {
        storageName: "registry-resource@template:html-ppt-crayon",
        versionId:
          "7991ad80f051da3d1715f3f1c10c3bf61de69f7746b5a8c67d655c13f6057119",
      };
    }
    case "template:html-ppt-creative-agency": {
      return {
        storageName: "registry-resource@template:html-ppt-creative-agency",
        versionId:
          "97bb467bff00a2b9b6c3e9a2ca2b633d9993937de58c10ce2d5f3a7cd372f86b",
      };
    }
    case "template:html-ppt-data-report": {
      return {
        storageName: "registry-resource@template:html-ppt-data-report",
        versionId:
          "37cf5cfefa5a03a9e420a09dec3e180fd8160ee4375e76d8e24940e6fb166fe7",
      };
    }
    case "template:html-ppt-editorial-magazine": {
      return {
        storageName: "registry-resource@template:html-ppt-editorial-magazine",
        versionId:
          "1d6ef172bff161ad705877b12ba3b6419d317e8810b42f0ef6c9312fc38d2b99",
      };
    }
    case "template:html-ppt-landing-consulting": {
      return {
        storageName: "registry-resource@template:html-ppt-landing-consulting",
        versionId:
          "621b5383d04b3d6214e9b12423cedf23900ddb07cae2e90b80937b2b662a668c",
      };
    }
    case "template:html-ppt-lumina": {
      return {
        storageName: "registry-resource@template:html-ppt-lumina",
        versionId:
          "31a7d9abd766a12851a1e0f5b2ac09f08d31f5cf469fa4f8f2f5b1835892bebb",
      };
    }
    case "template:html-ppt-mosaic-geometric": {
      return {
        storageName: "registry-resource@template:html-ppt-mosaic-geometric",
        versionId:
          "bd2ca98aba4e61281c7b431d1dd042fa26783b32196d993101861fbb2648a307",
      };
    }
    case "template:html-ppt-playful-pop": {
      return {
        storageName: "registry-resource@template:html-ppt-playful-pop",
        versionId:
          "9e8d84ec293962f6162b4ce609d849d5c61645f4894240e2a1fa3f6d6e179aec",
      };
    }
    default: {
      return undefined;
    }
  }
}

function findRegistryResource(id: string): PullableRegistryEntry | undefined {
  return (
    findSkill(id) ??
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
