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

// Every superseded generation of the Website archives keeps an entry here: the
// pre-cutover renderer packages, the renderer packages the direct-HTML cutover
// replaced, and each later direct-HTML refresh. Released CLI contexts pinned to
// any of those digests still resolve to their own immutable R2 versions. Remove
// this map under #26519 after the remaining rollback window closes.
const PREVIOUS_WEBSITE_TEMPLATE_ARCHIVE_VERSION_IDS_BY_SHA256 = {
  "template:black-slabs": {
    "8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3":
      "eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22",
    "38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9":
      "63e7780407504c15df178658ef2f694baa23d0a2a4199f38ac07fd9a302f5dac",
    "44126993be4b2932a270efcc21dbc855e60ccc0b280fadedc6ce2c90399f7e17":
      "8d5c6ba72363e8e63c2fe8badbd5412c5ca41c32349c2ec63cee757d9a2a1c8d",
  },
  "template:blueprint-grid": {
    "97c2edd94467bc414f0d9fc27cafa048cb2a7aaba3df5159df519a2bb2b97a4e":
      "78988a658604a25feb259d54e4543bfe6d57f85efe7ad67737e02c794d25e491",
    b5f058f3ec7881e642e31e44e7de1f94465bae783de7fc2d42727bbfd109fad2:
      "89c5a11d4a769e880e59a277fe8af1f1c173752ceea7539680d00d5225b3b717",
    "9fdf8c7555e85072b9c92526b098edbe90c3230a71f6a1ec08ec3fa902ebabf0":
      "0ce83ffb4e74289d5dbf7270551290e7774c254660ed86805bd040c8425fd103",
  },
  "template:coastal-hotel": {
    "9633475124da5728cbf99a7333b494f74842232faaf675bc7878a3ebcdf59bcb":
      "3907cdbed6078702a058ed9c66c1cdeb76f83f1062efcf3b046cce0bd5c8ed06",
    "6bba8c10b85a248a475624767616280fa5d29b757ce230fb4115d746b8b61386":
      "e5ac62f1ebdf025470172c2ce8275833274de49f6300c427eef0c142523b1246",
    b285b649b73c0b526734ce63b01de5f3f6704ed89f5e71a96f953484a882f979:
      "04260e1aa26477d09b7bfb38f03d471a0af5c58f3703fca94d20811097f2ce69",
  },
  "template:dot-matrix": {
    f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2:
      "293a2bc33150ca1f39132a8235c5cf355944e8d3e213b5f7703237314a2ac449",
    cfb8f891fa77eca2c3a58f1d95f046f873136f85c9c4a83400cba3a2ccca4ad9:
      "173d914b90d68648e9da9ee32cde12417fe55703b22f999b626b07f6053a7488",
    "9bb367c272e46942c33f51c5774b4e229929fd5fb330186bf9a23164bed1c56b":
      "4b4c686788d23a449b75705211432f1609c183149dce8ac9737a94fea2da6861",
  },
  "template:frame-stack": {
    "4587e93da51652c0c16c2d0706e8437001305214e4e6b8b1c18a6538b3daa127":
      "efbf1788c8b084aa12b7cd48f7a3bf5fc9964d1e6115edbd9124f8cacfbfb3ca",
    "642db1ff8e1c98e4c390245cb0fcda5ce29503721bc2a513c38448b9d4e2d01c":
      "422a07c5431dc689f2a0f832ffd5085149c64de6575be2c435fef01e36ffdb83",
    "182a63e7b268779b2d45a81651a99da6004873162b1a98d5da27f15be6338d15":
      "180a444fb5b96595e480d0218b349d4d2c0bb3c31102e706a292443f67983671",
  },
  "template:frosted-scatter": {
    "00e343ace0673ece5903a2b6abbad6bb960c17796e0cfa5cce0bcab7e6bcdd7b":
      "c4507fd54d252dc905df36d99f23ab65a4d41185b78e62515ff3eb3d87a381a4",
    "548a1faf423baa1c7c11befe41a54ae398cfb5c94df7f957eff108e2afcd613a":
      "02855a260801c5120ee62c04f3a0b9d4f4884caea89728264cc85c1f6a2d74ad",
    "32fb6fc4ebc85ffa3ea1672cd75005048519dfd1fbc3c1d4c254363d89ebb14e":
      "73b3b343a96b459b8bcc3da9a41c7ed533ab870c45b64e575326b14c690be337",
  },
  "template:gallery-wall": {
    c90332053b24572feadecb3994925ed317957e1cb17b0080cfebc6f4d9e93bd1:
      "9e81cd8b35f9f6374440cd3a4a8fc214db4a137962797df69bde46248c4e75f3",
    b477b2f05c266eccbd2ab3b822744873dd8a31db03981283688549f2936bd5c6:
      "26591a92b37e255dd8d565effc542115dd94292465e179c501c0518538cd27ce",
    "401854b89ea8b8ce98880309a190fa19e03647b564e64bc082ae481f3cb9c8fc":
      "d92042c684c6a50705a5792cd827b6e5b546d6e2b4f376ae80f67610c5564f94",
  },
  "template:glass-bloom": {
    "0c61488baa294fb13c58aa129e3ae99f0cd4ff9125459761a1b2c1390b860f93":
      "52d38ebc1e62b974f7ab2f6dba8823b0a2f7c43d5c11d8079f32e3ff85df1e50",
    "8707cce50c5477d43912fd18aa5ab6973aae4fd2287a092967fa25bf4ea38e7c":
      "297d1c1ed2639a3eead3212fcb3bf3c59ca80ee36562902cdec46ea8394b7398",
    ed9f6ef684cc89d5e6653b7f35a62988665a63993ca69305334399652cb7f586:
      "6106c1b544fea9d9efb226eae5f0281bb875e9aaa6661afb68b17e129ea2fbe3",
  },
  "template:serif-stack": {
    cf5137a7b6788f4d7cb24bda358a8e1971c0e7ed026d50e6cf292f6bf0cd0c14:
      "adee3b87f670c52a3cc4971e5dd8795f8ca05690087caff4b0d8b32b9029bead",
    "718d617efd92033a68c476e85bb9231b1e0ff580c08a1f6bedf1b86058e97f13":
      "165c2c576e7b2fccad2f490c6813e4705d5f87408fa24a8cec79d4ddf2392831",
    "55034642b7becda0da90d202c689e79938844142144fef15b5371706bdb3ef46":
      "b499ee4143bae451660589dc732413f42b6e3b0d2fcb26a11f4c1fb9d261e194",
  },
  "template:sticker-pop": {
    "2086113018279f28e23489cf7a0f3663c37a23210fb106c4ed48d8c19923f78f":
      "ddae2ff9236b0a4663dc19ad23b374488c0d4d9eddf9b5a4e8cad36011b0b420",
    "8145c78f932ae942108fba00c5de367958f12b4c492d61bc1310892abe51ca66":
      "c87a666429beb7d8fbaf3376c7229c701b53cdb36f4f714c6b45f0b6fdf3134a",
    d6a8fc7658fe0709a089d819fa745af461e99a1f1759040b60e8b0e4d4eb8ef4:
      "c3b0b7e74e3b61ac9a09bd64317a688c67b8e9f6b19095a965d5deeb46c8d334",
  },
  "template:warm-cards": {
    "2721c013f76e1b2eea09282269b33d7f143b7e83ee3e701e83a0fcf7773852dd":
      "0a87c99afe9cf24424aa1a1740a57cc3698e43f3c571b8ef1fd4560192f38746",
    a795ef022e672d364c7a966eb042d38e460d4dcb996d5eecb0647aac5dd259df:
      "47a5c7f01a7395d5be86483291c26e5f51e3fa8258c0d69705379ea9fb21849f",
    "30a7ce127311bcba581793c47f234c043474b9b7bdfca2ba0732bd35e065cee3":
      "9fade1ad5c3e5d48ec282d2bad6c0c67ae44da2525d633dd434be3c1d3e3651f",
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
