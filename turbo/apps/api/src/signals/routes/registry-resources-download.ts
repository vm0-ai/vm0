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
  findWebsiteTemplateResource,
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
  readonly sha256: string;
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
    "a7c6805b134a3892ac46e8aa4c89ab319ca6f58ac283c0aeb8de645eb88ba5ae",
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
  // Website template packages (self-contained per-template archives).
  "template:black-slabs":
    "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
  "template:black-slabs-v2":
    "bfdd76866483fc78cf49f1e05a55732c3001dc6edd0899433367773eb3ec2435",
  "template:blueprint-grid":
    "78988a658604a25feb259d54e4543bfe6d57f85efe7ad67737e02c794d25e491",
  "template:blueprint-grid-v2":
    "d7b65f9e32a9dc691ba9f96dfc45945d034ee7e841d53ff904a41038574572a3",
  "template:coastal-hotel":
    "3907cdbed6078702a058ed9c66c1cdeb76f83f1062efcf3b046cce0bd5c8ed06",
  "template:coastal-hotel-v2":
    "9851c21802d2c96cb0d6a4b799f73249287b1ed8b46ab94cb719ce4d9f38c3e8",
  "template:dot-matrix":
    "293a2bc33150ca1f39132a8235c5cf355944e8d3e213b5f7703237314a2ac449",
  "template:dot-matrix-v2":
    "c3dc44d2445926f7bdc65e017028155aff73d7d59bc0deb783faf6ba689dcf5b",
  "template:frame-stack":
    "efbf1788c8b084aa12b7cd48f7a3bf5fc9964d1e6115edbd9124f8cacfbfb3ca",
  "template:frame-stack-v2":
    "4b29a3ccedbd2259f2663e9bae60bafe0ca03ab98c415c0d2624f2dbd5379972",
  "template:frosted-scatter":
    "c4507fd54d252dc905df36d99f23ab65a4d41185b78e62515ff3eb3d87a381a4",
  "template:frosted-scatter-v2":
    "5076edab7ea87ad666e04ce74e8781f19eda8c660c697834d97a4e0d161f3035",
  "template:gallery-wall":
    "9e81cd8b35f9f6374440cd3a4a8fc214db4a137962797df69bde46248c4e75f3",
  "template:gallery-wall-v2":
    "26e2033b18e1a1c2efed697b3b29b0f8e589c4556de34bd2caff1dc801b377e5",
  "template:glass-bloom":
    "52d38ebc1e62b974f7ab2f6dba8823b0a2f7c43d5c11d8079f32e3ff85df1e50",
  "template:glass-bloom-v2":
    "3fc6629067c9581ccccd11b679e99e26dbbd45b9d15cce182ce4edb224216d1e",
  "template:serif-stack":
    "adee3b87f670c52a3cc4971e5dd8795f8ca05690087caff4b0d8b32b9029bead",
  "template:serif-stack-v2":
    "00b1f6cbce5f93d1df53adc3519b7f32ebc9c1417c78a88b7f2e98fa7aff231e",
  "template:sticker-pop":
    "ddae2ff9236b0a4663dc19ad23b374488c0d4d9eddf9b5a4e8cad36011b0b420",
  "template:sticker-pop-v2":
    "438eea8bf5a75642d2d645c035314416e1a0a44c9462d33b3fd6b36c6f21f673",
  "template:warm-cards":
    "0a87c99afe9cf24424aa1a1740a57cc3698e43f3c571b8ef1fd4560192f38746",
  "template:warm-cards-v2":
    "736c14987395cb828dfa3626ace6ea947ca9852509b64d2867c6be105bdb8a12",
} as const satisfies Record<string, string>;

// Presentation runbook versions keyed by the digest in the current registry.
const PRESENTATION_RUNBOOK_ARCHIVE_VERSION_IDS_BY_SHA256 = {
  "template:html-ppt-blueprint-academy-runbook": {
    d6f16dff7c2f7830b71a3d6ed3fd228f1de7a29fa7795e2a31afb9fc841a0f72:
      "04d537e1a2dce0874d8be914e90884b756a0f14e30589b6e805b23110d3c698e",
  },
  "template:html-ppt-botane-organic-runbook": {
    "052c937dc4a9c6e7c528265d86210c15488b19710d22437b25fb1710853c8a6f":
      "28ad523a1663716dfe740d9c4b37160a386fd40f78fc61597b35be9c348fe023",
  },
  "template:html-ppt-business-data-runbook": {
    c3ca2128d7dbfb2e683bb0386d5335505c1f540160481da1c97aae9ff52a15ac:
      "edbb8ebe65957687641e1a573b64ad49dc6a9de462c4e46d510d154c5eb60f19",
  },
  "template:html-ppt-crayon-runbook": {
    "1e698ca42b7a36dfa8a1ed6f45c2b25181bf1058c91207b934612a73701fae70":
      "c8d9c8f02e70819968fb78c04a70a6e537601e9a86667fd57b3cba4e8825efb4",
  },
  "template:html-ppt-creative-agency-runbook": {
    "7c3b33353bd22b2a6dc0c50c7ed9d3d97b159199ad30aa61b2abeb46a931b6ec":
      "ce79d73e31cb5acbfe55479e8c1629ba68f7548b477709d98057ee8675b26867",
  },
  "template:html-ppt-data-report-runbook": {
    "11747371adb6561e25cd4c3095caf62f52840c4ee625d234478f7631b746a9b3":
      "63302cec8a67a5179c9ba6309f267a62f4ee15b3e8403a5515821d23916c40c2",
  },
  "template:html-ppt-editorial-magazine-runbook": {
    d1ae6492925d2e9ed7cc0acc1684c33fea6613b6bef34b21aa228f01fc76c5d7:
      "cc0fd39023d6f920ae5dcae7a2dce3c176d1fd34392b35818f5bd2677e81f874",
  },
  "template:html-ppt-landing-consulting-runbook": {
    "01323dcebc9413781ad518d86f6b6611c3fb39a8bfd6287b2abced7c9432b6c7":
      "fc15dfea6f7dda89180e837843cc1dfbcdbe14b70361d39ef902a2d8ad42472c",
  },
  "template:html-ppt-lumina-runbook": {
    "38ae1652ababd62fbb2dcbc612a7a9458dae0b88283e09b34d113882f94ca063":
      "f36f3076811cf916762b1a24f9e44a209a0daa58efad275f5da32ed5dae700cc",
  },
  "template:html-ppt-meridian-runbook": {
    "6d31c74008ea8f854da929edb135ecbc8410dc3790e9c5ff8d43681029c1ecff":
      "b1af398afe34a0625f0fd08e97444ac77c26ffb218ec62c315fe338558fb9133",
  },
  "template:html-ppt-mosaic-geometric-runbook": {
    fd036b42ef323011f0a2c771ceb0bbc6cfb6fb29272633f4e187cd672a89d336:
      "0e11dc5bccb9abfa9d008c117aaf14908b363d20613bfbb57cab6267c90e90a5",
  },
  "template:html-ppt-neo-brutalism-runbook": {
    "70ca020b00cd79abdb471e3145f2bd706c1a2978fdd5870e372565033f3a4ead":
      "6b3fb7b9eabb60d76d37f40b86a71f95682fcbca08ce1c331f899f6e72c95239",
  },
  "template:html-ppt-nocturne-runbook": {
    "83d26dbd95a839310db7553b3a2e4dfe2cc3d9678d988fa864d4dd61f6941213":
      "ec30051e82c3d7cc903bc3bc9b7b1b3b5d94d134e897ede0f4b6e5f2a4a0dc8f",
  },
  "template:html-ppt-pixel-glitch-runbook": {
    bf3f5312f2281490f592c8d1c02477e57632299ea93b9e3eef65fe1dc2236e29:
      "958d5fe6f53598ff3cb920fe6dd91433b16a4eb5cbfb10fb179ae98b15765cce",
  },
  "template:html-ppt-playful-launch-runbook": {
    "78292a9a5c454e36a5255f22d147ac56f53c69538a4ac0897160239c2ca941e3":
      "6a81763e63f55e2fe446957fccd8bf770d02efe6d613b1fc988fc206b697d511",
  },
  "template:html-ppt-playful-pop-runbook": {
    "1c84b4a0df81a8ca169ac30a589410b8d846af5900c38d08fb77688b2556a565":
      "9625d8a2ba670cbeac3be21469c07ca90841c1d45defc0c1de674cf2e1e3d7f8",
  },
  "template:html-ppt-prospectus-runbook": {
    "0dc2b86b15970312003f6a60a90b03c47729870a38f85ae79c89547cd1cb485d":
      "a6ec614912182e6ace467ff0c96036f263cab8030d01146b414af5996e9f278c",
  },
  "template:html-ppt-schoolhouse-runbook": {
    "44e95a44ac37174b6dec3e2a2b21c0fe7d6d9f83c254d86cff1779030d5b11ad":
      "c063961c29369b15b8ae7a3cb285105bc29dbae84cccc36d458b666a5ca75e06",
  },
  "template:html-ppt-sticker-scrapbook-runbook": {
    cddd7f14573af6aa922b2873658dc81fbcd45dfb42b84da8be9b8e0866874dab:
      "4876f30e79ac5a035b79e210b0e2a99c4e989bba9c38f3b0ff046b4f56f857bc",
  },
  "template:html-ppt-strata-runbook": {
    "39ebdffe9de88faebb6427d734927b57ebe69b9b98db5efbee59b5f7ab120cc6":
      "56e7d344c982b946fc578d026ac8fbe1ee0ffe50d096be94cb25418bfa6fbd3a",
  },
  "template:html-ppt-taped-consulting-runbook": {
    "7b05540c82b410abd1f236ef8a42ff53601489a4a8531413983830d42cec614b":
      "f80b9966e449e3e0c07bf6f7d21c73c09f164fd2e144fdbb61c9aa59f2e138c6",
  },
  "template:html-ppt-vantage-runbook": {
    "096678c9f5bc1760b9f2c25bf10949296ddaa98511a2ecae2bc59528bd7969ed":
      "0172780a5797b6162eeb081390042289b80bcdc4ecf237142d3c89b830160381",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

export function resolvePrivateRegistryResourceArchive(
  id: string,
  expectedSha256: string,
  defaultSha256: string,
): PrivateRegistryResourceArchive | undefined {
  const defaultVersionId =
    PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS[
      id as keyof typeof PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS
    ];
  if (!defaultVersionId || expectedSha256 !== defaultSha256) {
    return undefined;
  }

  const requestedVersionId = (
    PRESENTATION_RUNBOOK_ARCHIVE_VERSION_IDS_BY_SHA256 as Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
  )[id]?.[expectedSha256];

  return {
    storageName: `registry-resource@${id}`,
    versionId: requestedVersionId ?? defaultVersionId,
    sha256: expectedSha256,
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
    findPresentationRunbookResource(id) ??
    findWebsiteTemplateResource(id)
  );
}

function archiveFilename(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`;
}

const downloadRegistryResourceInner$ = computed(async (get) => {
  const query = get(queryOf(registryResourceDownloadContract.download));
  const entry = findRegistryResource(query.id);
  const archive = entry?.source.archive;
  if (!entry || !archive) {
    return notFound(`Registry resource "${query.id}" has no archive source`);
  }

  const privateArchive = resolvePrivateRegistryResourceArchive(
    query.id,
    query.expectedSha256,
    archive.sha256,
  );
  if (!privateArchive) {
    return notFound(`Registry resource "${query.id}" is not private-pullable`);
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
      sha256: privateArchive.sha256,
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
