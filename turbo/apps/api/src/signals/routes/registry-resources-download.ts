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
    "3c4f3323dcf5d8a03a9780c3a46906706efbdc9f845d50c0d882e05d5ff1828f",
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
    "5f89b454969ac0ba0bb6417be0b42b3ff9e0dbe0af7cf832d51d9dc198f34bcf",
  "template:html-ppt-playful-launch":
    "ab66ed71a98e114679b6e3bd1fe61c160837c5197cc69ddd0d6c737b56ab0ac8",
  "template:html-ppt-business-data":
    "2a8c81df0e0f5acb2cd703816a4156a3e51d02b9e9bc60563331853569d85f35",
  "template:html-ppt-crayon":
    "d49deba891ffbd2b7ba767dd94451863ba4f36138819b15a47b762011cc8e04c",
  "template:html-ppt-creative-agency":
    "6f9672390e3f7f27a355ad5e6d96ec0f9e45f31bb92a36faaff02a8d5b7cae24",
  "template:html-ppt-data-report":
    "d0cef7bb7d9352b9bcff11c60b27edd39d230eac833736b0c97f79657f38020d",
  "template:html-ppt-editorial-magazine":
    "09cb5911f7c6dc84e9c55220954d590de5a94bba3e197413f7054f5859b07f47",
  "template:html-ppt-landing-consulting":
    "7be41feb6a0c1a41a9a45d9f62233bcb8a8c340e2977079aa2e19de685b3e09a",
  "template:html-ppt-lumina":
    "c00e7b7f2196705f2cbfcdb8ae67050f74e16523698b495b80e2aacea890084f",
  "template:html-ppt-mosaic-geometric":
    "d43e78bca6dd3a83082cd11a6e1f1f25b4f917bc476e65bb61d7d35a02e28865",
  "template:html-ppt-playful-pop":
    "80a15eda37a303768ccee897c81c0bcd9d265c0a377b34ce92a127951f8d0787",
  "template:html-ppt-nocturne":
    "e4f602af8e90d4070a532f32db797d563952d2dfce7743e804224cfd13e591e8",
  "template:html-ppt-neo-brutalism":
    "d208161627b8a737fdaa0aa0d2eea1b04296f39ec14c7b6d8f2fd4c7875f24a9",
  "template:html-ppt-bloom-pitch":
    "5bb98f6e726afedab710886dc9289d7f96a3045a1a907182f7c018be28e0f82a",
  "template:html-ppt-blueprint-academy":
    "b14af02df9ae609667a3c22874d6beeba55fef63c06f10f712574ffb730cc644",
  "template:html-ppt-meridian":
    "135f0291ad3c0573589fc425a69b39ead5d7ffc61fa5d9dc15e14d3ae67cf842",
  "template:html-ppt-pixel-glitch":
    "c99d1ec84c987a30d65cf1e4507adc230aa6e0467784f5a8ec69eef433274add",
  "template:html-ppt-prospectus":
    "ad08b7e58d64c584a54a7292c42c800dce6f3ed9049bbdc0991a88ad9393a169",
  "template:html-ppt-schoolhouse":
    "9c997ff8babbf3189b2580a0d4c0d2c65ff04235b3e34a6a6b2ca4d4d951cba3",
  "template:html-ppt-sticker-scrapbook":
    "38f73f5cf435233f9baa0ea67f2e73258947bf6b5a36f90cea5ae98b194ef40a",
  "template:html-ppt-strata":
    "fcfe92b3de8aa4ba5f69ab2327766137c49730d07a79a1627a7a838bbefe8859",
  "template:html-ppt-taped-consulting":
    "b4639811099781c662a9671126762c67c1cc726e7a545b7bfbed18032faace9b",
  "template:html-ppt-vantage":
    "93e9a05f8c9c7f5ad99b51b1b9dae87a16d026782458edcfa629a514242de3f6",
  // Presentation runbook packages (feature: presentationTemplateRunbook).
  "template:html-ppt-playful-launch-runbook":
    "f6f83c0a080db0a5b9f568c7b2640c1d179b06e1946cc5c339560bc76ee5e966",
  "template:html-ppt-bloom-pitch-runbook":
    "525f84ccfd25448284b1e668e2a036078a6aa6ad9da9d95497a2157b0f251b42",
  "template:html-ppt-blueprint-academy-runbook":
    "444945a0bcb95e3267ec65539275bd0c366b658af0d345481b9f59a70854661a",
  "template:html-ppt-botane-organic-runbook":
    "7a9d31935c465409720a7b5ac07924b0ee53b4c7ebb9c0fa2a5146661956e83e",
  "template:html-ppt-business-data-runbook":
    "1b3d0d01ab23b65d1819850b2a90563c243cef1cb75dff9d5f7592ca6bc40cf5",
  "template:html-ppt-crayon-runbook":
    "1b0f3872495a9698dc028d2e895a6681cfe59904064525c5e365ac4d2998fa13",
  "template:html-ppt-creative-agency-runbook":
    "b5d2c2495c919955a62090c015bf5ecec38c71675762f19c7c6224d5e16d6c7b",
  "template:html-ppt-data-report-runbook":
    "18d5e4485c3c8e8cf593124681798589c4c85b4cac8fc1bf36a7e2bfce952493",
  "template:html-ppt-editorial-magazine-runbook":
    "ee4b42751a319bbbb22843e4f3804ed91eb589cf7e93ac626831db213c5c66aa",
  "template:html-ppt-landing-consulting-runbook":
    "94ae28f81fd407e01c65091c28247d9d81283fc427ef4e7cb71df376eac7eb69",
  "template:html-ppt-lumina-runbook":
    "da319f7028fa7faa5d6182f98b33f90ae8c70e4a629c7b7a558f0120e22ae4df",
  "template:html-ppt-meridian-runbook":
    "3933f7aef70f5438207294da66af16d874c60d71a46d8883761b10108bf0fb8c",
  "template:html-ppt-mosaic-geometric-runbook":
    "e7c22f6243ee257e98c8f846115c161e136f8404c7ab92f7ea56967f36cf1637",
  "template:html-ppt-neo-brutalism-runbook":
    "28021eb23255a26c2c79b2df4781da76757adcc5a0444c27fdf694b2f64d544d",
  "template:html-ppt-nocturne-runbook":
    "e2cd45c05cd85f56fd9d0923118403c6d01cfeefffaa340d37d3773aa1f99f98",
  "template:html-ppt-pixel-glitch-runbook":
    "0cb9fa7100802558fc83caf5ae7b0b2b568bbab68cb97770b5408b7647ef4806",
  "template:html-ppt-playful-pop-runbook":
    "5ed8baaf3f0a1a17a87a6282d5c7e77d9c47ee6a2d66fdebaf1069aca37aff14",
  "template:html-ppt-prospectus-runbook":
    "22c33504b41722ddc7eedfe058dccdda99a8633996b2f507bb1e170c48312a98",
  "template:html-ppt-schoolhouse-runbook":
    "1d1ffea23e9d1c9c0d45476fac0fd633a5fad09b79b3221564352667e8915b88",
  "template:html-ppt-sticker-scrapbook-runbook":
    "d39c7cee5ad1734f631e23a442f822f5288ea6f272f32e852b2a60c8fcfe2a6b",
  "template:html-ppt-strata-runbook":
    "35205bdbf924f06920f62dbcb8acafa6016aceaec519d1d51d1beff4415dc374",
  "template:html-ppt-taped-consulting-runbook":
    "5b61c1e607017376ce39cb5ac0694421abd0c190d3e29ca71bb753b0633d98ad",
  "template:html-ppt-vantage-runbook":
    "c60678d5a3c45721118a4c6ed553a8fe3a4f33f7586ece1de55ad7bcaf4562b9",
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
