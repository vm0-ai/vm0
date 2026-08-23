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
 * bounded by `JOB_TIMEOUT = Duration::from_secs(7200)` in
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
    "f01d1c6e93e5bd2a2f4fe083a3cf6278fecda8c854913fae68a971e9ba5b268a",
  "template:html-ppt-blueprint-academy-runbook":
    "60808948227925dc149183bffd0109c16dd7e1d6bc02f72bb6b9c6621b6652dc",
  "template:html-ppt-botane-organic-runbook":
    "c8bb87195fbbd69d70d34628d179a0ef05de0c1a7f8e5b69fe0e47e439a6a7e0",
  "template:html-ppt-business-data-runbook":
    "a1a5487c108b8ec482ec8d9ba29de453af255df606c1e1273f71f60180bc867f",
  "template:html-ppt-crayon-runbook":
    "caf52d4fa167ea1d7cda2bb3a395b34622d5cf1ec8e8429750d569f617409527",
  "template:html-ppt-creative-agency-runbook":
    "dc77ef0b4108244c07dbf7b876cde7a492d6bab66b8f964b976d18c8a255e9d7",
  "template:html-ppt-data-report-runbook":
    "db16b7278a92abe5e337c77ce2c37e2d6e341b657bcb2244ecc637f63eed42c5",
  "template:html-ppt-editorial-magazine-runbook":
    "12b418d52c94b3d6d9d6bac0e29e6a1c06324fcda3608b043eb6f19b11fc9ce1",
  "template:html-ppt-landing-consulting-runbook":
    "878d90db4b73b46b1b5401ca4be4db08ac60dce2a5818fb03b541a262cc2e98a",
  "template:html-ppt-lumina-runbook":
    "1fc90d062e5ffad07f534703afe914bd3139cf7ec823a911d7b1a294ac3a3a37",
  "template:html-ppt-meridian-runbook":
    "7c32f0af1ed4ab08a6f9f0ad574750ea82b36c2203b26e1bdf9c6374820eb9bf",
  "template:html-ppt-mosaic-geometric-runbook":
    "1091979fa03bfe273b8e0623d30ec757af0c4fed68fef4b2e0d9157375082899",
  "template:html-ppt-neo-brutalism-runbook":
    "236eeb0fd0b64ca39fa93110802bd6584dcfbd7d29ed6325c4ca7284985aa642",
  "template:html-ppt-nocturne-runbook":
    "23b175b13a44d17f4c1fa43b968c48f985870332352d16e8fc31f19f7b80e719",
  "template:html-ppt-pixel-glitch-runbook":
    "c5541e04883a4687a586a363dbc41dc46501d498ea03579ef4655970bca8abf8",
  "template:html-ppt-playful-launch-runbook":
    "14b7e7fdfbc3401004039cf0a2e43ac235e605b014a3beb69df3883b74b5eda1",
  "template:html-ppt-playful-pop-runbook":
    "17e0d91f0b7c7b5354c60850a90d5f9ca8627f9aee064f10fe7b87bd8650ff50",
  "template:html-ppt-prospectus-runbook":
    "7ccba0e3a58bd5db6151d6365d8c439bd8192c6ded10f4d1e441ae60bb7af55a",
  "template:html-ppt-schoolhouse-runbook":
    "336fc7d044a97b970d741c6782fcd2742d63bd6475ef8b1db232d84f6b9b5227",
  "template:html-ppt-sticker-scrapbook-runbook":
    "afb984e327543adb769810a7961e65973033363982d2a729b8967181166bd826",
  "template:html-ppt-strata-runbook":
    "3c1051437748a41d3907e15f366467b8d6b1457115783e8152bcf9739d63324b",
  "template:html-ppt-taped-consulting-runbook":
    "279efb09bdaa7598747932f39eca1043023f4364834df819958b19536386385d",
  "template:html-ppt-vantage-runbook":
    "e1640374607ff6f8b3cacd67c29f105d3c52abf2cebf2b4945ebf334a2a429ea",
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
