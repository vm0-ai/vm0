const CURRENT_WEBSITE_TEMPLATE_ARCHIVE_VERSION_IDS = {
  "template:black-slabs":
    "63e7780407504c15df178658ef2f694baa23d0a2a4199f38ac07fd9a302f5dac",
  "template:black-slabs-v2":
    "3a7ccdd16e0c710cf20a0deddbd02d3a58a8125d2b3542648bc261bbaf9c5c91",
  "template:blueprint-grid":
    "89c5a11d4a769e880e59a277fe8af1f1c173752ceea7539680d00d5225b3b717",
  "template:blueprint-grid-v2":
    "c86f579ecca5f29d45eab19ae19157bdc9a9bc14c99cdbf8611b86aaae3aea70",
  "template:coastal-hotel":
    "e5ac62f1ebdf025470172c2ce8275833274de49f6300c427eef0c142523b1246",
  "template:coastal-hotel-v2":
    "7c13e39abcabf4cb31bdecdac80e096d6e039367e23c55ca0c3e6647d8fb3583",
  "template:dot-matrix":
    "173d914b90d68648e9da9ee32cde12417fe55703b22f999b626b07f6053a7488",
  "template:dot-matrix-v2":
    "9a8977088b02b43d15654674571a88c0128b29076bb8e837d47ddd3a6ea4fd6a",
  "template:frame-stack":
    "422a07c5431dc689f2a0f832ffd5085149c64de6575be2c435fef01e36ffdb83",
  "template:frame-stack-v2":
    "cb8cf528ebfce90e6f78081fbaee0029f2790ff5398ffa0642a6c30c8c1e0c1b",
  "template:frosted-scatter":
    "02855a260801c5120ee62c04f3a0b9d4f4884caea89728264cc85c1f6a2d74ad",
  "template:frosted-scatter-v2":
    "7cab5008dbe877dd5ac43e3511d06109d101dda389bbdcc4589396ff495d9d41",
  "template:gallery-wall":
    "26591a92b37e255dd8d565effc542115dd94292465e179c501c0518538cd27ce",
  "template:gallery-wall-v2":
    "c208b3119387422c4487d1a9a6f3c8f1618d0ee77dcfd51cbe26e6b4092cb002",
  "template:glass-bloom":
    "297d1c1ed2639a3eead3212fcb3bf3c59ca80ee36562902cdec46ea8394b7398",
  "template:glass-bloom-v2":
    "fe6ac8450b6f822707c3e38c2705b2b88828c9226befa090086dc53635d9f9b6",
  "template:serif-stack":
    "165c2c576e7b2fccad2f490c6813e4705d5f87408fa24a8cec79d4ddf2392831",
  "template:serif-stack-v2":
    "e61f178818ccf31a0676ca0183fccbaef3019972adab592d8a5ba17287f54f65",
  "template:sticker-pop":
    "c87a666429beb7d8fbaf3376c7229c701b53cdb36f4f714c6b45f0b6fdf3134a",
  "template:sticker-pop-v2":
    "d358cbcd29fc725fc282f4675ebba533fd60af564038d8efa0d4a057a29aee5b",
  "template:warm-cards":
    "47a5c7f01a7395d5be86483291c26e5f51e3fa8258c0d69705379ea9fb21849f",
  "template:warm-cards-v2":
    "f587c890c6db593a4cd102cb863f2484868277200d5630b40712ee8b2ded3153",
} as const satisfies Record<string, string>;

// Pre-cutover commit-addressed CLI contexts can keep these digests through
// their queue, claimed-run, and finalization lifetime. Remove this map after
// that drain and the production rollback window close; tracked by #26519.
const PREVIOUS_WEBSITE_TEMPLATE_ARCHIVE_VERSION_IDS_BY_SHA256 = {
  "template:black-slabs": {
    "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3":
      "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
  },
  "template:blueprint-grid": {
    "97c2edd94467bc414f0d9fc27cafa048cb2a7aaba3df5159df519a2bb2b97a4e":
      "78988a658604a25feb259d54e4543bfe6d57f85efe7ad67737e02c794d25e491",
  },
  "template:coastal-hotel": {
    "9633475124da5728cbf99a7333b494f74842232faaf675bc7878a3ebcdf59bcb":
      "3907cdbed6078702a058ed9c66c1cdeb76f83f1062efcf3b046cce0bd5c8ed06",
  },
  "template:dot-matrix": {
    f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2:
      "293a2bc33150ca1f39132a8235c5cf355944e8d3e213b5f7703237314a2ac449",
  },
  "template:frame-stack": {
    "4587e93da51652c0c16c2d0706e8437001305214e4e6b8b1c18a6538b3daa127":
      "efbf1788c8b084aa12b7cd48f7a3bf5fc9964d1e6115edbd9124f8cacfbfb3ca",
  },
  "template:frosted-scatter": {
    "00e343ace0673ece5903a2b6abbad6bb960c17796e0cfa5cce0bcab7e6bcdd7b":
      "c4507fd54d252dc905df36d99f23ab65a4d41185b78e62515ff3eb3d87a381a4",
  },
  "template:gallery-wall": {
    c90332053b24572feadecb3994925ed317957e1cb17b0080cfebc6f4d9e93bd1:
      "9e81cd8b35f9f6374440cd3a4a8fc214db4a137962797df69bde46248c4e75f3",
  },
  "template:glass-bloom": {
    "0c61488baa294fb13c58aa129e3ae99f0cd4ff9125459761a1b2c1390b860f93":
      "52d38ebc1e62b974f7ab2f6dba8823b0a2f7c43d5c11d8079f32e3ff85df1e50",
  },
  "template:serif-stack": {
    cf5137a7b6788f4d7cb24bda358a8e1971c0e7ed026d50e6cf292f6bf0cd0c14:
      "adee3b87f670c52a3cc4971e5dd8795f8ca05690087caff4b0d8b32b9029bead",
  },
  "template:sticker-pop": {
    "2086113018279f28e23489cf7a0f3663c37a23210fb106c4ed48d8c19923f78f":
      "ddae2ff9236b0a4663dc19ad23b374488c0d4d9eddf9b5a4e8cad36011b0b420",
  },
  "template:warm-cards": {
    "2721c013f76e1b2eea09282269b33d7f143b7e83ee3e701e83a0fcf7773852dd":
      "0a87c99afe9cf24424aa1a1740a57cc3698e43f3c571b8ef1fd4560192f38746",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

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

  if (expectedSha256 === defaultSha256) {
    return currentVersionId;
  }

  return (
    PREVIOUS_WEBSITE_TEMPLATE_ARCHIVE_VERSION_IDS_BY_SHA256 as Readonly<
      Record<string, Readonly<Record<string, string>>>
    >
  )[id]?.[expectedSha256];
}
