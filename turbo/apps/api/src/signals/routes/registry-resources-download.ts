import { computed } from "ccstate";
import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";
import {
  findColorSystem,
  findDesignSystem,
  findImageStyle,
  findPresentationReverseTemplateResource,
  findPresentationRunbookResource,
  findSkill,
  findTemplate,
  findTool,
  findVideoTemplate,
  findWebsiteTemplateResource,
  type RegistryEntry,
  type VideoTemplateRegistryEntry,
} from "@okouai/core/resource-registry";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { resolveWebsiteTemplateArchiveVersionId } from "../../lib/website-template-archive-versions";
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
  // Presentation reverse-template guide from vm0-ai/Template-artifact@7daba24.
  "skill:presentation-reverse-template":
    "ec707d2338ddec36a4b413ba7fe58c35987b2b85b2a8ecd441add68dcc1472e7",
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
  // Emboss & Deboss from vm0-ai/vm0-skills@e696652.
  "image-style:emboss-deboss":
    "e84748dd61e087cc15f12d9f9ecf19d68de790d747e0075b3f9bb6be38975e95",
  // Image style packages manually published from vm0-ai/vm0-skills@45e237a.
  "image-style:cozy-parlor":
    "b6ce5ecd7207360f6929616daea4c054aa9583ee24ca64eeb7d5aca5c9767db5",
  "image-style:crowd-ink":
    "3389f30fbdc8248c5885ab94edb667a3d7fb4a17018162233bf0ca6c4d5e72cc",
  "image-style:editorial-flatfolk":
    "d03620d739815baca2764e9fa3ea520a639d0487988c47f58bdb17fca61fd80a",
  "image-style:endpaper":
    "72f75194d1e27bf5b9222473a74c63fe27ca700e435c4e47cb7642d44d8f1297",
  "image-style:flat-poster":
    "73292de49674ba797b2f86b3babb14b899ba5e7047c9f13dc63fce52c81d04aa",
  "image-style:folk-muse":
    "3446e78cf337b24dd1a5a6530fe2926b7ca6b153b7393be338b782b633543cdc",
  "image-style:folk-storybook":
    "96a309a4bc6ddf6fdc30488a0a74e576a0a7f1ebbae2da14b08a0dd9cc02b9d7",
  "image-style:grain-poster":
    "771417220bcea158f9729e15b085de61aeb0d771d5dd39ca6e63711a8b47c4e5",
  "image-style:grainy-duotone":
    "21b5f3f0f6ec7d32ba3e1c8ff49048c481327f484807c093465824c0fbbf26c6",
  "image-style:iberian-vignette":
    "7e875c6fd6f154d87aa27d0aceb69dbb36fe084299642d2d3ec0c24fdb2dd730",
  "image-style:ink-mascot":
    "408ab314cc262395fbd6d257cb981976327a5b6a2742d62b3646b9dc49c7df07",
  "image-style:ink-storefront":
    "ec8d871a9739e6d276b058336904b6a95bdc0ec56de5de91b40bdd8cc910277b",
  "image-style:inkdab":
    "40e1663067c705935086ed61d8e7610da32b4dab707b92e3dc1a3a60fdc44dbe",
  "image-style:inkstomp":
    "035a7fe17aef573086f24552de23363adc39f51b28d2b5415a59da4fac83a98a",
  "image-style:iso-scene":
    "32b295fff8931cbc1db4754b481ee432e70119da22f32881ebab180479c7a6f8",
  "image-style:jade-blockprint":
    "5a1103c33434979c4ce997da0e2f66cb8f90ba598d20b319b09e47d8ec2af289",
  "image-style:light-pop-portrait":
    "77eafa06066c0f8ebfa11af0fe83eace551db5e008378f710d3264dba45e4b82",
  "image-style:loose-contour":
    "228ad875fdad30feb0101f48db70d58a7cdcf200c07510d256a539bea292ee1f",
  "image-style:mellow-pop":
    "32ce89482cc85dc27b20ccbf57756b814f9fae88bc7cf5f5979a7b26b5f0dc26",
  "image-style:mosaic-still-life":
    "db22e147647987a182e69fba0ce1864b2f5dff5c0b5e1a6db7487b0ce22c13a1",
  "image-style:notion-illustration":
    "82d5ab3a95484702df121449dda63c086cd7ef06e9240c6620846afd5bfea079",
  "image-style:op-ed-cover":
    "c5223ade7d86bef1691d71e95286558a5ff533ca604d51d360bea20c4f250f48",
  "image-style:painterly-botanical":
    "3c6f0874686d0e021680bf28dfd81e7eb81d0eaa6b355e4732c524c5bfac3d4a",
  "image-style:papernook":
    "aada3a4b40f0989d779ee1d3b1471addca557cafd8135d0cd061932d0e7e2314",
  "image-style:postcard-illustration":
    "1fd4876ba668a0b6ff5bff0c95610c6ba8f8a87dbcebe31d91c73955358a2aa4",
  "image-style:riso-relic":
    "b3c5bd37419a0f627ee7a4c8941a4a21c351e5d4f45cec82eefa7ddaf58adfd6",
  "image-style:shadow-pop":
    "5c1179938f3bb07ca84a11b2ea4e01c3bcdd72f0383d5549434fe4ffe37b8969",
  "image-style:soft-vector":
    "ede91c010b3ac2b5bd80df9dca436ce9006acd9ac5af7f33c5590309ca7c6f53",
  "image-style:sticker-sheet":
    "a5d1fbaeeb87247996c5b6d801fb135b4b6e5f5db9a4c22f4cb58269578c33f7",
  "image-style:sunlit-gouache":
    "9156b502d879ce3f8715ec3aa309d62e46ee691d5f86d5a8355f14aec90b4d3a",
  "image-style:tiny-wanderer":
    "f728fa4248d2da8ba9be92c14266059c613952e5d8d6e5b2e3a73fe8bacced55",
  "image-style:vm0-illustration":
    "820d2e2ce81805d935e4098d5b6f2899967c2ad5c0af4586f794010c6db66966",
  // Presentation runbook packages (self-contained per-template archives).
  "template:html-ppt-bloom-pitch-runbook":
    "497e4273d24490f3cdee17acb628d45e050993b1d184ac2055075928104ecb32",
  "template:html-ppt-blueprint-academy-runbook":
    "3bad140c244d8b7b2e9f59fe03cd2632d272cf27475cb6e8912e79c07fa2e685",
  "template:html-ppt-botane-organic-runbook":
    "e254a8a30653053e47cb7dd38d47cf3af3b12d41ad3fd8adc597d6b7cafb5a43",
  "template:html-ppt-business-data-runbook":
    "b4123b1cb5c52f963c2eea0d2c93decd10b0b8d53dd0993b929810fb5cf3ef49",
  "template:html-ppt-crayon-runbook":
    "06ea2690e2d1020807422c3add9b86c6e64ccd7870c91b98e40f6e323483d46d",
  "template:html-ppt-creative-agency-runbook":
    "671c05f5d36647b5a0d6b5a70c9f123912861a9578fb1c810efd4e105daec51f",
  "template:html-ppt-data-report-runbook":
    "0985049fe03377d34c631362ad896dad59a9f7a439f09b005698d206e330facf",
  "template:html-ppt-editorial-magazine-runbook":
    "01f505612db766ee1229487632d7f2a9d0fd2103fc6d5fb6144354c778882cb2",
  "template:html-ppt-landing-consulting-runbook":
    "ea0f579ddc193d289c8f8d5ab24f23d62dd80f3a37b29b78065d0d01ef378539",
  "template:html-ppt-lumina-runbook":
    "5cd06f02b2448c516953476df872bc870bda5458dd6b569a68df2631589321a9",
  "template:html-ppt-meridian-runbook":
    "4ac9ff4ab93c27b08b6eeb54dda6745bf53366c9e5104636014b4642762aa6f9",
  "template:html-ppt-mosaic-geometric-runbook":
    "dc3462ea37e2e42071779217152a4a0353c054b4b0e585b2ab7ffda5b3f9069a",
  "template:html-ppt-neo-brutalism-runbook":
    "44066ab6e1aa52c802465bda13c435c066a6f3a3fee9c3068f5966447ec53b31",
  "template:html-ppt-nocturne-runbook":
    "7c7adb5ec12610aae9b282086daa526a6eaf3c6ff3ff53de9d1f4c739563a328",
  "template:html-ppt-pixel-glitch-runbook":
    "22437d165feecc89edb012746a8cb51eaa46c8513157466f7e26e6384aa45e47",
  "template:html-ppt-playful-launch-runbook":
    "57894521c0f259ba2d5062fbe56467e7f0d5dbd809527e13f9777de982e3eb06",
  "template:html-ppt-playful-pop-runbook":
    "dc3eb029aa3dc5afb249a3cb6f397c89fcf44bdba7feaa69c57af5ec7ed0cdb1",
  "template:html-ppt-prospectus-runbook":
    "635d67c5f800106ac5cec967895d4f4512b812499b8b0d11c8bf6f06a3d88430",
  "template:html-ppt-schoolhouse-runbook":
    "713573a006fa509211d3c60d95ee41b06b66d5a044d1685fc4ff972c84f91333",
  "template:html-ppt-sticker-scrapbook-runbook":
    "532797d90df8878c6b2c8356046cc45c2939230e15adf8ad31e0e4a1985b8316",
  "template:html-ppt-strata-runbook":
    "9f50574bfee6c4002cd3ec02c05c1fd26ee96346748a053af5d995be9fc34e4c",
  "template:html-ppt-taped-consulting-runbook":
    "fc9012486f15c0bc7ab969bf6e6997632c2765673b2b4c07b79d3209e635430c",
  "template:html-ppt-vantage-runbook":
    "5f2bea9d3c153836bc5f9ca6c447ed5318bca0a5c0eaabf36ece3833f2c38d67",
} as const satisfies Record<string, string>;

/**
 * Superseded digests that still have to resolve to their own immutable R2
 * version.
 *
 * Rollout fallback. Surface: existing runner/sandbox, up to 2 hours. A run
 * whose execution context pinned a `CLI_PKG_URL` from before a republication
 * carries a CLI whose bundled registry only knows the previous digest, and it
 * keeps asking for that digest for the queue lifetime plus a claimed run —
 * bounded by the shared `AGENT_EXECUTION_TIMEOUT_SECONDS` contract in
 * `turbo/packages/api-contracts/src/contracts/runners.ts`, enforced by
 * `crates/runner/src/executor/mod.rs`. See the "Commit-addressed CLI artifacts"
 * section of `docs/deployment-compatibility.md`.
 *
 * Each entry is removable 2 hours after every new execution context carries a
 * CLI built past the republication that added it.
 */
const PREVIOUS_PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS_BY_SHA256 = {
  // Pre-refactor guide from vm0-ai/Template-artifact@fc829f4, replaced when the
  // extractor pipeline was removed.
  "skill:presentation-reverse-template": {
    "4d11467afafb68c7ac221a4ac66e237cf7a05a8f4bb17c29e09ba6ec64b394b5":
      "108b2ba3b9d1994da6f4f6ddf219992a2ca9f2584edf5f448269d523e8d5b988",
  },
  // Superseded presentation runbook digests retained across the
  // vm0-ai/Template-artifact@b4b701a and @73ae68e republications.
  "template:html-ppt-bloom-pitch-runbook": {
    b9003d1545000987eac1868220b4ea1379ec1cdd79e884bc08d13539c1cc5f88:
      "ec842f388ab90b98e0dadb3ffeb560bbd4b0a0aaaa93b84725732d98bf225710",
    "732a602bf37d8f10d8be14c63fd7ae12de0591dae41f9661fd29aa8591bc6465":
      "a27d82cae6cdeb84103c70705e2a2f6193948cbdb894aaeee6d3638de949bb11",
  },
  "template:html-ppt-blueprint-academy-runbook": {
    "3ba06b6767eb7fb59c7e4e1599acb908f1684c18bfed2f8d29231e6f057e065e":
      "7dca9890d2c2416b84cdb953d3c5be4a614f2913599a5e6dd990229e266b12a5",
    "3f3cc69eb216990518ee46164ea0a69a370ce5714d566c0e995a98f8acd2a9d8":
      "02077258dd6ba2d12271ffedc2d1cf6c0ac3a16f6eb9a92246a92a5419e176ed",
  },
  "template:html-ppt-botane-organic-runbook": {
    f422972f28f470b894e46739aa0cdec8604b7bda7b0738a9ebca3541e553f2ec:
      "861c2b0e4d1e819e73498bbfd139ba0b95ee40dabc1d2b8189d63eae557e62e7",
    b4824cc2e220af95203b0041d959d3be53253878e760a2502b79e2d8503319cf:
      "07231d8f7259db331a7b21eb190e7d887d9e26fb1b7dcacac46c3ca018ebd9d6",
  },
  "template:html-ppt-business-data-runbook": {
    cf039ee1f7a989af9935658f7920b7862ce029b57763f71c8562abdb6e9061d8:
      "cbe95f8e00c38c5cfdce0b72e5a09f5e4d464f8d7dac3151387027957c55d80f",
    "1f35bf0411a528948e94e8fdccb530aea3f2ee81681277bf720161937c2c47c2":
      "c8b571a0e2033a8167578685431daa54ebd4e37349771a972c059eb4b18c80d2",
  },
  "template:html-ppt-crayon-runbook": {
    "2f67f694ead043195e8ec3cbf3e0843e09df6d93dc49f57a261f0f7bd503ae2a":
      "16dc23497a7f6b8e4e0ced506bef7f5f126d0b069315cab319543a646e89a988",
    "24547aae70248b373e13b32bfcba39a53bb4d0ddc8b5ded502e9e0f4d967629a":
      "10d96f99628483c0316558e0e953ada3752a1081e8efa5cf5de2d7c80a535062",
  },
  "template:html-ppt-creative-agency-runbook": {
    "14ee0f1e2e3dcfd36fc571bb747681a063dfb43eb62a70f67d0fd06aa79ef977":
      "68c2d284c9bb93ace0e10f3f4c508549eaebecc2cc0638510ad38349e2324a55",
    "98d4308b77075181a9bc25c97eb5aab63d406f08fbbdc11240b5242c18695ba0":
      "335fbaeab805a9a43d12aa76109b76967d068e3589abc583309bd91f46c57d06",
  },
  "template:html-ppt-data-report-runbook": {
    "199bc3e337e66069ade2d15c3f71488e7d15b1cb2d25da8baffd943e13aceefa":
      "64cca3c4fde4a49ee4cd215ed02ed85f4a198a6f5938e844c18b172ba68c9db7",
    "64c088e596fd4a5d00ff2d001725eab1ff9ccdf12b66360eff968a42adbd1af8":
      "7f12591d77e7f10370e719177d9bd6971bb39f70ee523db4d63f1903b5be1c58",
  },
  "template:html-ppt-editorial-magazine-runbook": {
    "0068cfa0a3d91a9cbaeed98685f99afa6355dda8a4cab1d5e3cf7bb0e3d232f3":
      "8ab0a2a68c7a5020a3d142e75af739144542a7ff41c5a3d2e590881acc6178b3",
    e135fe2d90af35ad9cc177718d1758c36e7089fe63ac4b075203c1c06f12ba35:
      "cb9ab480b90d244bdad2a5558685e029179f0cbca24440f5b839645f56dba1e6",
  },
  "template:html-ppt-landing-consulting-runbook": {
    "622fa1cca454f057d4b5eaaa412033276ed6ad014ac7a79bc5b82cd1aaba0725":
      "e79f61d0053d69bcc413963fcb56b3677bc6a84616afe90be20374dfef55174a",
    "94781705145e5dff3595dd9e5c08fc0e8985c29737ecf664554a91d6ccc95482":
      "51e83fa99ace1efecc4a9377fc568b5e0019570b0c41d07bc7e91b8dd23134fd",
  },
  "template:html-ppt-lumina-runbook": {
    "470aa7096ac3c676d644cdf74369ddcb8d120231e1981d7e7c27844d48142ab1":
      "9d589fee85ed6094bb064049ae24692e104ccbeb7bcda89e707991e7039abf4e",
    ee353d4ecefdbe8cda164bd6174baff75a549671c5d0f720b75eca31bf26c3bb:
      "eb6caf4fef7a9c9a090619adaa9d519cfa07853ccf0187c606845f2ff45a05c2",
  },
  "template:html-ppt-meridian-runbook": {
    "16ceb52885a5a93dd6ff909cbc95d2a8a27d6d8ac79ce4e6b906e57b17d69fde":
      "f15524e2361922bf0e6eed507c937c642261863a78aa856483238ce954547ba3",
    "37072fe02a4e4df34d064f39237f98895b5d6d7514857171aa6cb99cdf57209b":
      "0a2640e872d20da93b749b47fa530d910ae3767372de7a539e1da08fb9a86d0a",
  },
  "template:html-ppt-mosaic-geometric-runbook": {
    "722f6ea996166bdce3a6ab5f0292d1ead73488f03c6ad1138883e47506971cfe":
      "03be08ea6767942ee6d9d2fd2eced72ec0dfaecd2bc7d473c01a0093c39d48eb",
    "8b6698813045d4cf52e26d5cd73ca6574529e58e1f2cc22a6db9de7b3b6a3a18":
      "c122104f5f40ab093ef7ff18fc9a7becbba21eda1834a7e4ae500e5be3bad012",
  },
  "template:html-ppt-neo-brutalism-runbook": {
    "488508a363064e08774ba3fc10eff15f72d0bc0df4ff19df841a8772869bd7a5":
      "df9fe0cb53d1afd611b47bece0ebd81fb8fb036d84910cd20b302b80706f8a41",
    ebb3a334c12473527009ea73d2c6b2097d38b3502bd6d12e610ceab9ae0ca252:
      "6ef2724a5b511909c72e404b9fa6f67e0269a535eca6bd484bc73316bfd99cfe",
  },
  "template:html-ppt-nocturne-runbook": {
    "22db828e89979fdbc6e388568f600098f781b03cff28a99419b4101057394227":
      "1b684cfa4128f95aeee027e41324050005cfb528fcc26f099d7eb54e37661e0b",
    f78892def8d6a214ec3eadb384fce8da13dfec686319d9383798f536b8187fbb:
      "2a20b5307b01ca1ae43de4b8045dcd1be4d68c43123d34d77e10a770cc9e5092",
  },
  "template:html-ppt-pixel-glitch-runbook": {
    "085c7f8276e7ff9f2c26d19da7bffcd436dcdbd895b741b24134e11c685e9d91":
      "c2e9d8b90f00a6df09d3a4ad33357fc32baab03196b68d52d66b1a2ec1e3c0a0",
    "242b7f6df74dfc3799de68a11e721d6def4552b05009a9578e1cb88622c371e5":
      "109943a86459c9c1a3197d94124b7f96f85c71023f73fd9850ac3e9cc19ed3ce",
  },
  "template:html-ppt-playful-launch-runbook": {
    b336b934a2f18904f2af959bf1da999f17bb71d5b727b30c94c89766dc8adcfb:
      "4135191a92b54a3babde10edf9f972cf83f3aeae582165bd6eabec274fde8b9d",
    e7ce6bda402a444b83ada485c71c3e0538b3692b4803cd7f96054ca07e81180a:
      "e1a4b54088cf63a29f56780ca31dbfdba0ba39ff32c9a9ad14a4a470773862c0",
  },
  "template:html-ppt-playful-pop-runbook": {
    "6f07a5183e71c5f1ab51fabb606433bf2bce40675c5612e47c0040aa21ca8358":
      "72bbfc0132f41cc130f5efcbd5f692233375847c46c67e646ac890cbe9bfce97",
    d3de99c9b8e931de2343d511dda04f57d1deaa29c945ef4c91a5382e948c9263:
      "87adf6d8063be6acd9a8aa044d2cd4359932c2dd238a6403aed03c32f11cfda7",
  },
  "template:html-ppt-prospectus-runbook": {
    fe2905801b1f8beff802640b717e421c7882da2b015254bba160a92f036f190f:
      "74ee81efc7b5f6794ddf077357e1e845c773b3d77ae9e02948911b19f8220919",
    "7ec19e6ce032544d1e4653bed9485fce0a5551bea6197c450e0b60bc28d7d16f":
      "4b57858e10558e741c3577dafa7bfdef9b96a1ff9be4c7a8c3cfc6c4fc9266a2",
  },
  "template:html-ppt-schoolhouse-runbook": {
    e37fd617e744c2e89765ec0b24a30977ad89a876a30176e0bacf8e32209f5394:
      "81e7f95dd13cec5f08f54ac965c51b62f87d9c7f8d29370c027aeeed3758571c",
    "387b2fb59ecac95dbe3b4e6f27d7e6ebda3ce4be317227f6506f87d02e264fc0":
      "5968097de13a9a0dda66c464cdd744a53f2018442610775eef4630d21b74c403",
  },
  "template:html-ppt-sticker-scrapbook-runbook": {
    "8bfb271c21004703cc7151358080b5c622c7ec18eb4a5492643f35c5825aadcf":
      "899be9feba1fbc6eba3515b6e06c97e800956b399d025269bd2daaa6fc1a9653",
    a00b744d85d2e668cb98945e9758bc6222ea4f3c3b62e72842f1568d35501f3f:
      "16218ebefa4d55554f7db7e6d6e7f18ffe6c53e657b044db7ea69781b11c4906",
  },
  "template:html-ppt-strata-runbook": {
    "78aea76e0a6aceb8fbe77a771781cbd276255f2728fc31fb5617d19550432617":
      "518f9b636a8cbf091d9147da200822fbc297a343a3cea95d9546f43a8000d458",
    c1396282cf80446b4cb97f8fa6859b5bd95c50090f8dcf1278a817e6e0b64cfb:
      "9f403b39dc7eab2db4d09ad74e1acd89201d6f982c654166af19ce6b69165fa6",
  },
  "template:html-ppt-taped-consulting-runbook": {
    bbf846cbf4c6591375d9b668f6e0fdf380d387fddb5c2eb173d935b03486b83f:
      "16c64fa119f5aa68607c831b2fa79330f597e10fa01501b8a063443bd7561639",
    c4ccffadd45dac50b9b8dc3bf0fd6f2ffa91e1cc6691ba63b5a7a1784e16d7ca:
      "33b13adddfe94f558ed91ae235e69312b3f4fc5150ff77b6718253eaf6c69ff0",
  },
  "template:html-ppt-vantage-runbook": {
    a6290319d2b8065ce105949a5f02ba37ed1738cf9c354cd74e4742826b7ee753:
      "7b0b0f91b885c67147dc800191edd4b80a62f9bfe0dd6dbe7fcfb49b8e4f8027",
    "888b1478b295e1e6b0e7ae5b579261206fce4edf48c6f42893194471cdeb2c78":
      "6e845f03b79a1c4683f9b9bfe8f018eb9808642d6cadbef9ab505d6892ab5adb",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

export function resolvePrivateRegistryResourceArchive(
  id: string,
  expectedSha256: string,
  defaultSha256: string,
): PrivateRegistryResourceArchive | undefined {
  const websiteVersionId = resolveWebsiteTemplateArchiveVersionId(
    id,
    expectedSha256,
    defaultSha256,
  );
  if (websiteVersionId) {
    return {
      storageName: `registry-resource@${id}`,
      versionId: websiteVersionId,
      sha256: expectedSha256,
    };
  }

  const defaultVersionId =
    PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS[
      id as keyof typeof PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS
    ];
  if (!defaultVersionId) {
    return undefined;
  }

  const versionId =
    expectedSha256 === defaultSha256
      ? defaultVersionId
      : (
          PREVIOUS_PRIVATE_REGISTRY_RESOURCE_ARCHIVE_VERSION_IDS_BY_SHA256 as Readonly<
            Record<string, Readonly<Record<string, string>>>
          >
        )[id]?.[expectedSha256];
  if (!versionId) {
    return undefined;
  }

  return {
    storageName: `registry-resource@${id}`,
    versionId,
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
    findPresentationReverseTemplateResource(id) ??
    findPresentationRunbookResource(id) ??
    findWebsiteTemplateResource(id)
  );
}

function archiveFilename(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "-")}.tar.gz`;
}

const downloadPresentationTemplateInner$ = computed(async (get) => {
  const query = get(
    queryOf(registryResourceDownloadContract.downloadPresentationTemplate),
  );
  const entry = findPresentationRunbookResource(query.id);
  if (!entry || !entry.source.archive) {
    return notFound(`Presentation template "${query.id}" was not found`);
  }

  const anchor = resolvePrivateRegistryResourceArchive(
    query.id,
    entry.source.archive.sha256,
    entry.source.archive.sha256,
  );
  if (!anchor) {
    return notFound(`Presentation template "${query.id}" was not found`);
  }

  const db = get(db$);
  const [storage] = await db
    .select({
      id: storages.id,
      headVersionId: storages.headVersionId,
    })
    .from(storageVersions)
    .innerJoin(
      storages,
      and(
        eq(storages.id, storageVersions.storageId),
        eq(storages.name, anchor.storageName),
      ),
    )
    .where(eq(storageVersions.id, anchor.versionId))
    .limit(1);

  if (!storage?.headVersionId) {
    return notFound(`Current archive for "${query.id}" was not found`);
  }

  const [version] = await db
    .select({
      s3Key: storageVersions.s3Key,
    })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        eq(storageVersions.id, storage.headVersionId),
      ),
    )
    .limit(1);

  if (!version) {
    return notFound(`Current archive for "${query.id}" was not found`);
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
    },
  };
});

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
    route: registryResourceDownloadContract.downloadPresentationTemplate,
    handler: authRoute(
      { requiredCapability: "file:read" },
      downloadPresentationTemplateInner$,
    ),
  },
  {
    route: registryResourceDownloadContract.download,
    handler: authRoute(
      { requiredCapability: "file:read" },
      downloadRegistryResourceInner$,
    ),
  },
];
