/**
 * Private R2 version ids for the built-in presentation runbook archives.
 *
 * The registry pins one content digest per package, and the download route is
 * asked for a specific digest. Both published versions therefore have to stay
 * resolvable: a run created while `LatestPresentationTemplates` was off keeps
 * requesting the pre-cutover digest long after the switch flips, and the R2
 * objects behind both are immutable.
 *
 * Rollout fallback. Surface: existing runner/sandbox, up to 2 hours. A run
 * whose execution context pinned a `CLI_PKG_URL` from before this change
 * carries a CLI whose bundled registry only knows the pre-cutover digest, and
 * it keeps asking for that digest for the queue lifetime plus a claimed run —
 * bounded by the shared `AGENT_EXECUTION_TIMEOUT_SECONDS` contract in
 * `turbo/packages/api-contracts/src/contracts/runners.ts`, enforced by
 * `crates/runner/src/executor/mod.rs`. See the "Commit-addressed CLI artifacts"
 * section of `docs/deployment-compatibility.md`.
 *
 * Removable once the switch is terminal and 2 hours have passed since every
 * new execution context carries the post-cutover CLI. Remove this module, the
 * switch, and the disabled branch's tests together; follow-up
 * vm0-ai/vm0#28672.
 */

const CURRENT_PRESENTATION_RUNBOOK_ARCHIVE_VERSION_IDS = {
  "template:html-ppt-bloom-pitch-runbook":
    "ec842f388ab90b98e0dadb3ffeb560bbd4b0a0aaaa93b84725732d98bf225710",
  "template:html-ppt-blueprint-academy-runbook":
    "7dca9890d2c2416b84cdb953d3c5be4a614f2913599a5e6dd990229e266b12a5",
  "template:html-ppt-botane-organic-runbook":
    "861c2b0e4d1e819e73498bbfd139ba0b95ee40dabc1d2b8189d63eae557e62e7",
  "template:html-ppt-business-data-runbook":
    "cbe95f8e00c38c5cfdce0b72e5a09f5e4d464f8d7dac3151387027957c55d80f",
  "template:html-ppt-crayon-runbook":
    "16dc23497a7f6b8e4e0ced506bef7f5f126d0b069315cab319543a646e89a988",
  "template:html-ppt-creative-agency-runbook":
    "68c2d284c9bb93ace0e10f3f4c508549eaebecc2cc0638510ad38349e2324a55",
  "template:html-ppt-data-report-runbook":
    "64cca3c4fde4a49ee4cd215ed02ed85f4a198a6f5938e844c18b172ba68c9db7",
  "template:html-ppt-editorial-magazine-runbook":
    "8ab0a2a68c7a5020a3d142e75af739144542a7ff41c5a3d2e590881acc6178b3",
  "template:html-ppt-landing-consulting-runbook":
    "e79f61d0053d69bcc413963fcb56b3677bc6a84616afe90be20374dfef55174a",
  "template:html-ppt-lumina-runbook":
    "9d589fee85ed6094bb064049ae24692e104ccbeb7bcda89e707991e7039abf4e",
  "template:html-ppt-meridian-runbook":
    "f15524e2361922bf0e6eed507c937c642261863a78aa856483238ce954547ba3",
  "template:html-ppt-mosaic-geometric-runbook":
    "03be08ea6767942ee6d9d2fd2eced72ec0dfaecd2bc7d473c01a0093c39d48eb",
  "template:html-ppt-neo-brutalism-runbook":
    "df9fe0cb53d1afd611b47bece0ebd81fb8fb036d84910cd20b302b80706f8a41",
  "template:html-ppt-nocturne-runbook":
    "1b684cfa4128f95aeee027e41324050005cfb528fcc26f099d7eb54e37661e0b",
  "template:html-ppt-pixel-glitch-runbook":
    "c2e9d8b90f00a6df09d3a4ad33357fc32baab03196b68d52d66b1a2ec1e3c0a0",
  "template:html-ppt-playful-launch-runbook":
    "4135191a92b54a3babde10edf9f972cf83f3aeae582165bd6eabec274fde8b9d",
  "template:html-ppt-playful-pop-runbook":
    "72bbfc0132f41cc130f5efcbd5f692233375847c46c67e646ac890cbe9bfce97",
  "template:html-ppt-prospectus-runbook":
    "74ee81efc7b5f6794ddf077357e1e845c773b3d77ae9e02948911b19f8220919",
  "template:html-ppt-schoolhouse-runbook":
    "81e7f95dd13cec5f08f54ac965c51b62f87d9c7f8d29370c027aeeed3758571c",
  "template:html-ppt-sticker-scrapbook-runbook":
    "899be9feba1fbc6eba3515b6e06c97e800956b399d025269bd2daaa6fc1a9653",
  "template:html-ppt-strata-runbook":
    "518f9b636a8cbf091d9147da200822fbc297a343a3cea95d9546f43a8000d458",
  "template:html-ppt-taped-consulting-runbook":
    "16c64fa119f5aa68607c831b2fa79330f597e10fa01501b8a063443bd7561639",
  "template:html-ppt-vantage-runbook":
    "7b0b0f91b885c67147dc800191edd4b80a62f9bfe0dd6dbe7fcfb49b8e4f8027",
} as const satisfies Record<string, string>;

// Pre-cutover CLI contexts and the disabled side of LatestPresentationTemplates
// deliberately request these digests.
const PREVIOUS_PRESENTATION_RUNBOOK_ARCHIVE_VERSION_IDS_BY_SHA256 = {
  "template:html-ppt-bloom-pitch-runbook": {
    "7f05f31603d2ad3055b23147cc2b41e047c5969b6640502489b34bd33a837d62":
      "a7c6805b134a3892ac46e8aa4c89ab319ca6f58ac283c0aeb8de645eb88ba5ae",
  },
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

export function resolvePresentationRunbookArchiveVersionId(
  id: string,
  expectedSha256: string,
  defaultSha256: string,
): string | undefined {
  const currentVersionId = (
    CURRENT_PRESENTATION_RUNBOOK_ARCHIVE_VERSION_IDS as Readonly<
      Record<string, string>
    >
  )[id];
  if (!currentVersionId) {
    return undefined;
  }

  if (expectedSha256 === defaultSha256) {
    return currentVersionId;
  }

  return (
    PREVIOUS_PRESENTATION_RUNBOOK_ARCHIVE_VERSION_IDS_BY_SHA256 as Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
  )[id]?.[expectedSha256];
}
