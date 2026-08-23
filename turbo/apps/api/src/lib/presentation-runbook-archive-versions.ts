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
    "e3e73784c35c1bcd60f40c69201843ffce1c9e4f50a88aec40ff087f347f9e56",
  "template:html-ppt-blueprint-academy-runbook":
    "ec0defd87a4e9afe838507188a5505a4d7c8c1d12dab97ac6c6d84748cffcb64",
  "template:html-ppt-botane-organic-runbook":
    "f12e570aca218108b8b47732654dd48e12ecbd91eb5fd4636bc23620649f3b74",
  "template:html-ppt-business-data-runbook":
    "32e271a536714f57112245425306dd03ae3e0f99f5a300836a607e364fb14558",
  "template:html-ppt-crayon-runbook":
    "0e059390f386568e8926b860aabf039a2236bc6a848ab09c772865581b6134df",
  "template:html-ppt-creative-agency-runbook":
    "bb78a6cb923eba78baf0e5df7d578e662cc5759177d2c719b15f31c9ba1e5a19",
  "template:html-ppt-data-report-runbook":
    "4b0c27627f0f2678629e8c80161689751d1694c461e361604868412b62ee1c71",
  "template:html-ppt-editorial-magazine-runbook":
    "ee0ae3079ede81b27ee93f75d4b1955515812079f7ac003d57796a69767d0e0e",
  "template:html-ppt-landing-consulting-runbook":
    "288e486d84b74f283169008a809c45810e25e9bcf1eb5cfc3160378010aac132",
  "template:html-ppt-lumina-runbook":
    "fef2381cdab885d4342f78709147687fdb740d874fbb17cabd61ad67144206b0",
  "template:html-ppt-meridian-runbook":
    "e488f9271b5a21ff96af939eb036e9ed3a5f813a46b7d3dc3893c5db624b095f",
  "template:html-ppt-mosaic-geometric-runbook":
    "d26dffa248cdded1c67ceb2f0caeeff0d47e121b7f0b5e5ec42bfb57c744c7c8",
  "template:html-ppt-neo-brutalism-runbook":
    "459e32c6b21149e23d2a1f5c1d0baa775f8d80d7a1ecca9b589b248d18c5c2cd",
  "template:html-ppt-nocturne-runbook":
    "fb49f224f5a9bb79bf58deff53cb410d3cfef42a7d236e2e74ada5326cb0627b",
  "template:html-ppt-pixel-glitch-runbook":
    "d3178a3d4254084a8e01fdb9c5acaef2483718e8dd4ea527123c5b14026f5922",
  "template:html-ppt-playful-launch-runbook":
    "820847365300c3f5e9b06ec6107961d44eed467a7ed64a3fa84ff0f99383580c",
  "template:html-ppt-playful-pop-runbook":
    "739d574be1d370e433cefdb160c982d64de474e7bb1afc6619e5b30e81e5f639",
  "template:html-ppt-prospectus-runbook":
    "5763cb85870664d6d4c1b63f3e38d841f86717e2361e9d2eebc47a4aa0944b55",
  "template:html-ppt-schoolhouse-runbook":
    "c32e817ea80e696aaf288d3a4076e6ab59bc9e3f3364f56d3e5f704aac1811df",
  "template:html-ppt-sticker-scrapbook-runbook":
    "261cfe145a278ded8214e7c201e1cf2ae7bb547ad1b258a739b842dad18a4fe4",
  "template:html-ppt-strata-runbook":
    "98e339feef68f251d2813c81e37278ea7ba5a40814d8241f7876adf850e1e8c1",
  "template:html-ppt-taped-consulting-runbook":
    "335e24b12868f5807a4a7a04b370720ee8b4298a43d331e308dda8e2b731b571",
  "template:html-ppt-vantage-runbook":
    "432a6c78831a3d007669f0e505f6a33de03e38273ae6bb17dd92702cfcb99011",
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
