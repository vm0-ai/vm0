import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@vm0/api-contracts/contracts/registry-resources";
import {
  findDesignSystem,
  findSkill,
  findTemplate,
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
    id: "skill:presentation-deck-tools",
    versionId:
      "a11aab6b73aad5796a77875492564f269d8e4f62c7fbfbf302ab228d43fca5ff",
  },
  {
    id: "design-system:berry-pop",
    versionId:
      "8a7b9e507e793d31f5d97a126a2eb1e65d7faf299dbdc802ecf1a7e3b88ec4df",
  },
  {
    id: "design-system:mauve-dusk",
    versionId:
      "83f12acbb4e377f92f13bc37a203d9111a537237900913233dd7f6ce6bfffa0b",
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
    id: "design-system:pop-art",
    versionId:
      "1b1d654c9cc605abe0b7fd230d706a66b72cf4ae9a5951cd743ccc4eff09ee5f",
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
  const entry = id.startsWith("template:")
    ? findTemplate(id)
    : id.startsWith("skill:")
      ? findSkill(id)
      : findDesignSystem(id);
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
