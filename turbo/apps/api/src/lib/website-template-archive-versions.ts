const CURRENT_WEBSITE_TEMPLATE_ARCHIVE_VERSION_IDS = {
  "template:black-slabs":
    "037045074360d1e6b499fc37a4c5cad208dfd79e59a53bdea78910c5fbe9f2f9",
  "template:black-slabs-v2":
    "3a7ccdd16e0c710cf20a0deddbd02d3a58a8125d2b3542648bc261bbaf9c5c91",
  "template:blueprint-grid":
    "bbe1a91664e813adf179071713b159fbcd25c42fe9d06860f2ecaea907b06d2b",
  "template:blueprint-grid-v2":
    "c86f579ecca5f29d45eab19ae19157bdc9a9bc14c99cdbf8611b86aaae3aea70",
  "template:coastal-hotel":
    "dfcc93538a28f4dd902e82908991c3ed1ee4657f81b12e425ca3469b0bf67af0",
  "template:coastal-hotel-v2":
    "7c13e39abcabf4cb31bdecdac80e096d6e039367e23c55ca0c3e6647d8fb3583",
  "template:dot-matrix":
    "fe4915d7c67bfc7e259192072647f62cb064066b0854a84e7fa7cc85bff43112",
  "template:dot-matrix-v2":
    "9a8977088b02b43d15654674571a88c0128b29076bb8e837d47ddd3a6ea4fd6a",
  "template:frame-stack":
    "e9675a20ab0cc0c3970a21ef88716fd5f6f774bf7107739181d1545d6c39d466",
  "template:frame-stack-v2":
    "cb8cf528ebfce90e6f78081fbaee0029f2790ff5398ffa0642a6c30c8c1e0c1b",
  "template:frosted-scatter":
    "2954955f13a31eeb5a9b5cf69c6c170a92c328ed807eed8573bbac52685e2b16",
  "template:frosted-scatter-v2":
    "7cab5008dbe877dd5ac43e3511d06109d101dda389bbdcc4589396ff495d9d41",
  "template:gallery-wall":
    "8a2ca4ee5c50294cf54053fc29122196b4265fe5955eeec86bd0967778b86033",
  "template:gallery-wall-v2":
    "c208b3119387422c4487d1a9a6f3c8f1618d0ee77dcfd51cbe26e6b4092cb002",
  "template:glass-bloom":
    "ad5b00f8a2ceb176aa7de7906345d18ab798d0b6835d86ab1e58bfa033822dee",
  "template:glass-bloom-v2":
    "fe6ac8450b6f822707c3e38c2705b2b88828c9226befa090086dc53635d9f9b6",
  "template:serif-stack":
    "0dcd6eccf59e23d06c2f4653f001db9bb58b443a0ca0d4bfbd3e411a69ea781d",
  "template:serif-stack-v2":
    "e61f178818ccf31a0676ca0183fccbaef3019972adab592d8a5ba17287f54f65",
  "template:sticker-pop":
    "1435824e871307371108ca9176b8e67dfe1ba4538d52abbf6e6b7b196f5393ad",
  "template:sticker-pop-v2":
    "d358cbcd29fc725fc282f4675ebba533fd60af564038d8efa0d4a057a29aee5b",
  "template:warm-cards":
    "1ca8a11a520ed6225a32634fe3f2b0f443d10c28f64098f0f1bd0a795a62f16c",
  "template:warm-cards-v2":
    "f587c890c6db593a4cd102cb863f2484868277200d5630b40712ee8b2ded3153",
} as const satisfies Record<string, string>;

export function resolveWebsiteTemplateArchiveVersionId(
  id: string,
  expectedSha256: string,
  defaultSha256: string,
): string | undefined {
  const currentVersionId = (
    CURRENT_WEBSITE_TEMPLATE_ARCHIVE_VERSION_IDS as Readonly<
      Record<string, string>
    >
  )[id];
  if (!currentVersionId) {
    return undefined;
  }

  return expectedSha256 === defaultSha256 ? currentVersionId : undefined;
}
