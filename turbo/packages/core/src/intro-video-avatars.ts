import type { AvatarVideoAvatar } from "@okouai/api-contracts/contracts/avatar-video";

const HEYGEN_SUPPORTED_API_ENGINES = [
  "avatar_v",
  "avatar_iv",
  "avatar_iii",
] as const;

export interface HeyGenIntroVideoAvatar {
  readonly key: string;
  readonly name: string;
  readonly gender?: string;
  readonly previewWidth: number;
  readonly previewHeight: number;
  readonly provider: "heygen";
  readonly avatarId: string;
  readonly previewUrl?: never;
  readonly groupId: string;
  readonly defaultVoiceId: string;
  readonly preferredOrientation: "landscape";
  readonly renderEngine: "avatar_iv";
  readonly supportedApiEngines: typeof HEYGEN_SUPPORTED_API_ENGINES;
  readonly transparentBackgroundValidated: false;
}

/**
 * A curated intro-video presenter.
 *
 * `coverUrl` points at a background-removed cutout published under
 * `static.vm0.io`. Those objects are hard cached for one year and immutable, so
 * a re-cut of the artwork must be published under a new `v<n>/` prefix rather
 * than by overwriting the current one.
 *
 * The intrinsic cutout size is carried alongside the URL because the picker
 * lays the cards out as a masonry grid and needs the aspect ratio before the
 * image loads.
 */
export interface IntroVideoAvatar extends AvatarVideoAvatar {
  readonly coverUrl: string;
  readonly cutoutWidth: number;
  readonly cutoutHeight: number;
}

/**
 * Presenters offered by the intro-video wizard.
 *
 * `id` is the JoggAI public avatar id, which is what the generated prompt and
 * the avatar-video API both key off. Only avatars with a published cutout
 * appear here, so this list is deliberately narrower than the full JoggAI
 * catalog used by the generic avatar-video template picker.
 */
export const INTRO_VIDEO_AVATARS: readonly IntroVideoAvatar[] = [
  {
    id: 1785,
    name: "Amara",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1785.webp",
    cutoutWidth: 480,
    cutoutHeight: 1011,
  },
  {
    id: 1756,
    name: "Andrew",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1756.webp",
    cutoutWidth: 480,
    cutoutHeight: 538,
  },
  {
    id: 1146,
    name: "Archie Outdoors",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1146.webp",
    cutoutWidth: 480,
    cutoutHeight: 441,
  },
  {
    id: 1753,
    name: "Bradley",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1753.webp",
    cutoutWidth: 480,
    cutoutHeight: 528,
  },
  {
    id: 1780,
    name: "Cara",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1780.webp",
    cutoutWidth: 480,
    cutoutHeight: 1017,
  },
  {
    id: 715,
    name: "Chanju News",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/715.webp",
    cutoutWidth: 480,
    cutoutHeight: 545,
  },
  {
    id: 1788,
    name: "Charles",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1788.webp",
    cutoutWidth: 480,
    cutoutHeight: 968,
  },
  {
    id: 1246,
    name: "Chiara",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1246.webp",
    cutoutWidth: 480,
    cutoutHeight: 547,
  },
  {
    id: 1049,
    name: "Col Health & Fitness",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1049.webp",
    cutoutWidth: 480,
    cutoutHeight: 503,
  },
  {
    id: 1139,
    name: "Dan Education",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1139.webp",
    cutoutWidth: 480,
    cutoutHeight: 435,
  },
  {
    id: 284,
    name: "David in Studio",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/284.webp",
    cutoutWidth: 476,
    cutoutHeight: 702,
  },
  {
    id: 1722,
    name: "Dennis",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1722.webp",
    cutoutWidth: 480,
    cutoutHeight: 421,
  },
  {
    id: 419,
    name: "Dentist Kevin",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/419.webp",
    cutoutWidth: 480,
    cutoutHeight: 691,
  },
  {
    id: 1208,
    name: "Diego",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1208.webp",
    cutoutWidth: 480,
    cutoutHeight: 846,
  },
  {
    id: 235,
    name: "Dr. Müller in the Hospital",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/235.webp",
    cutoutWidth: 480,
    cutoutHeight: 736,
  },
  {
    id: 1769,
    name: "Eden",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1769.webp",
    cutoutWidth: 480,
    cutoutHeight: 1103,
  },
  {
    id: 613,
    name: "Edward Health & Fitness",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/613.webp",
    cutoutWidth: 480,
    cutoutHeight: 550,
  },
  {
    id: 1686,
    name: "Eleanor",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1686.webp",
    cutoutWidth: 480,
    cutoutHeight: 829,
  },
  {
    id: 1687,
    name: "Ellie",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1687.webp",
    cutoutWidth: 480,
    cutoutHeight: 756,
  },
  {
    id: 1695,
    name: "Ellie",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1695.webp",
    cutoutWidth: 480,
    cutoutHeight: 747,
  },
  {
    id: 1854,
    name: "Eric",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1854.webp",
    cutoutWidth: 480,
    cutoutHeight: 869,
  },
  {
    id: 1790,
    name: "Fiona",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1790.webp",
    cutoutWidth: 480,
    cutoutHeight: 1153,
  },
  {
    id: 1764,
    name: "Georgia",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1764.webp",
    cutoutWidth: 480,
    cutoutHeight: 797,
  },
  {
    id: 1470,
    name: "Giulia",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1470.webp",
    cutoutWidth: 480,
    cutoutHeight: 636,
  },
  {
    id: 1800,
    name: "Grant",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1800.webp",
    cutoutWidth: 480,
    cutoutHeight: 675,
  },
  {
    id: 1201,
    name: "Harper",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1201.webp",
    cutoutWidth: 480,
    cutoutHeight: 701,
  },
  {
    id: 828,
    name: "Hazel Health & Fitness",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/828.webp",
    cutoutWidth: 480,
    cutoutHeight: 457,
  },
  {
    id: 1787,
    name: "Isabella",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1787.webp",
    cutoutWidth: 480,
    cutoutHeight: 1167,
  },
  {
    id: 768,
    name: "Jabari Education",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/768.webp",
    cutoutWidth: 480,
    cutoutHeight: 472,
  },
  {
    id: 1844,
    name: "Jade",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1844.webp",
    cutoutWidth: 480,
    cutoutHeight: 776,
  },
  {
    id: 1694,
    name: "James",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1694.webp",
    cutoutWidth: 480,
    cutoutHeight: 476,
  },
  {
    id: 1112,
    name: "Jim Business",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1112.webp",
    cutoutWidth: 480,
    cutoutHeight: 781,
  },
  {
    id: 1690,
    name: "John",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1690.webp",
    cutoutWidth: 480,
    cutoutHeight: 757,
  },
  {
    id: 861,
    name: "Jordan Health & Fitness",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/861.webp",
    cutoutWidth: 480,
    cutoutHeight: 562,
  },
  {
    id: 1782,
    name: "Joseph",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1782.webp",
    cutoutWidth: 480,
    cutoutHeight: 734,
  },
  {
    id: 1818,
    name: "Juliet",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1818.webp",
    cutoutWidth: 480,
    cutoutHeight: 923,
  },
  {
    id: 260,
    name: "Kai Playing",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/260.webp",
    cutoutWidth: 480,
    cutoutHeight: 745,
  },
  {
    id: 1728,
    name: "Keith",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1728.webp",
    cutoutWidth: 480,
    cutoutHeight: 811,
  },
  {
    id: 330,
    name: "Kofi's Relaxing",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/330.webp",
    cutoutWidth: 480,
    cutoutHeight: 736,
  },
  {
    id: 261,
    name: "Lars Creating",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/261.webp",
    cutoutWidth: 480,
    cutoutHeight: 719,
  },
  {
    id: 653,
    name: "Layla Education",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/653.webp",
    cutoutWidth: 480,
    cutoutHeight: 589,
  },
  {
    id: 1851,
    name: "Lily",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1851.webp",
    cutoutWidth: 480,
    cutoutHeight: 830,
  },
  {
    id: 1475,
    name: "Linda",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1475.webp",
    cutoutWidth: 480,
    cutoutHeight: 830,
  },
  {
    id: 1820,
    name: "Mabel",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1820.webp",
    cutoutWidth: 480,
    cutoutHeight: 1029,
  },
  {
    id: 1428,
    name: "Madison",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1428.webp",
    cutoutWidth: 480,
    cutoutHeight: 775,
  },
  {
    id: 1789,
    name: "Madison",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1789.webp",
    cutoutWidth: 480,
    cutoutHeight: 1042,
  },
  {
    id: 1477,
    name: "Maggie Business",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1477.webp",
    cutoutWidth: 480,
    cutoutHeight: 705,
  },
  {
    id: 1245,
    name: "Maja",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1245.webp",
    cutoutWidth: 480,
    cutoutHeight: 694,
  },
  {
    id: 1240,
    name: "Marco",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1240.webp",
    cutoutWidth: 480,
    cutoutHeight: 724,
  },
  {
    id: 1281,
    name: "Mark",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1281.webp",
    cutoutWidth: 480,
    cutoutHeight: 899,
  },
  {
    id: 1204,
    name: "Megan",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1204.webp",
    cutoutWidth: 480,
    cutoutHeight: 940,
  },
  {
    id: 1786,
    name: "Michelle",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1786.webp",
    cutoutWidth: 480,
    cutoutHeight: 1016,
  },
  {
    id: 1429,
    name: "Natalie",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1429.webp",
    cutoutWidth: 480,
    cutoutHeight: 817,
  },
  {
    id: 1213,
    name: "Nicole",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1213.webp",
    cutoutWidth: 480,
    cutoutHeight: 935,
  },
  {
    id: 1781,
    name: "Nora",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1781.webp",
    cutoutWidth: 480,
    cutoutHeight: 1108,
  },
  {
    id: 434,
    name: "Nurse Elowen",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/434.webp",
    cutoutWidth: 480,
    cutoutHeight: 796,
  },
  {
    id: 76,
    name: "Pablo Black T-shirt",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/76.webp",
    cutoutWidth: 480,
    cutoutHeight: 733,
  },
  {
    id: 393,
    name: "Raven Office Room",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/393.webp",
    cutoutWidth: 480,
    cutoutHeight: 538,
  },
  {
    id: 1091,
    name: "Samuel Business",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1091.webp",
    cutoutWidth: 480,
    cutoutHeight: 688,
  },
  {
    id: 1425,
    name: "Savannah",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1425.webp",
    cutoutWidth: 480,
    cutoutHeight: 802,
  },
  {
    id: 1770,
    name: "Scarlett",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1770.webp",
    cutoutWidth: 480,
    cutoutHeight: 1133,
  },
  {
    id: 395,
    name: "Seraphina Room",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/395.webp",
    cutoutWidth: 480,
    cutoutHeight: 313,
  },
  {
    id: 1427,
    name: "Skylar",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1427.webp",
    cutoutWidth: 480,
    cutoutHeight: 443,
  },
  {
    id: 989,
    name: "Sonia News",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/989.webp",
    cutoutWidth: 480,
    cutoutHeight: 503,
  },
  {
    id: 1772,
    name: "Susan",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1772.webp",
    cutoutWidth: 480,
    cutoutHeight: 1634,
  },
  {
    id: 1431,
    name: "Taylor",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1431.webp",
    cutoutWidth: 480,
    cutoutHeight: 655,
  },
  {
    id: 1791,
    name: "Tessa",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1791.webp",
    cutoutWidth: 480,
    cutoutHeight: 769,
  },
  {
    id: 1713,
    name: "Tiffany",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1713.webp",
    cutoutWidth: 480,
    cutoutHeight: 594,
  },
  {
    id: 953,
    name: "Timothy Business",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/953.webp",
    cutoutWidth: 480,
    cutoutHeight: 502,
  },
  {
    id: 1721,
    name: "Uma",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1721.webp",
    cutoutWidth: 480,
    cutoutHeight: 1021,
  },
  {
    id: 1834,
    name: "Vanessa",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1834.webp",
    cutoutWidth: 480,
    cutoutHeight: 918,
  },
  {
    id: 442,
    name: "Victoria in Gallery",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/442.webp",
    cutoutWidth: 480,
    cutoutHeight: 882,
  },
  {
    id: 1144,
    name: "Wendy",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1144.webp",
    cutoutWidth: 480,
    cutoutHeight: 542,
  },
  {
    id: 1833,
    name: "Wendy",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1833.webp",
    cutoutWidth: 480,
    cutoutHeight: 761,
  },
  {
    id: 1691,
    name: "William",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1691.webp",
    cutoutWidth: 480,
    cutoutHeight: 397,
  },
  {
    id: 1792,
    name: "William",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1792.webp",
    cutoutWidth: 480,
    cutoutHeight: 813,
  },
  {
    id: 1749,
    name: "Willow",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1749.webp",
    cutoutWidth: 480,
    cutoutHeight: 949,
  },
  {
    id: 1842,
    name: "Wren",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1842.webp",
    cutoutWidth: 480,
    cutoutHeight: 1208,
  },
  {
    id: 1220,
    name: "Yuki",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1220.webp",
    cutoutWidth: 480,
    cutoutHeight: 596,
  },
  {
    id: 1217,
    name: "Zainab",
    coverUrl: "https://static.vm0.io/platform/avatars/intro-video/v1/1217.webp",
    cutoutWidth: 480,
    cutoutHeight: 586,
  },
];

/**
 * HeyGen public Studio Avatar looks curated for Intro Video.
 *
 * Provider preview media is intentionally not persisted while usage rights are
 * being confirmed. Every card uses one bundled placeholder; the provider IDs
 * and capabilities below came from the read-only v3 catalog inventory on
 * 2026-09-03. `defaultVoiceId` is diagnostic metadata only and never selects a
 * product voice.
 */
export const HEYGEN_INTRO_VIDEO_AVATARS = [
  {
    avatarId: "Abigail_standing_office_front",
    groupId: "1727646977",
    name: "Abigail Office Front",
    gender: "female",
    defaultVoiceId: "c4313f9f0b214a7a8189c134736ce897",
  },
  {
    avatarId: "Amelia_standing_business_training_front",
    groupId: "1727642048",
    name: "Amelia Business Training Front",
    gender: "female",
    defaultVoiceId: "a13e0ac19f484525ad9c781651cbd2d3",
  },
  {
    avatarId: "Annie_Business_Casual_Standing_Front_public",
    groupId: "e0e84faea390465896db75a83be45085",
    name: "Annie Business Casual Standing Front",
    gender: "female",
    defaultVoiceId: "330290724a1b470fb63153f34d4c0183",
  },
  {
    avatarId: "Blanka_sitting_lounge_front",
    groupId: "1727648625",
    name: "Blanka Lounge Front",
    gender: "female",
    defaultVoiceId: "02880d1c6fd94b7799d91135581ed810",
  },
  {
    avatarId: "Caroline_Business_Standing_Front_public",
    groupId: "977b1ab85dba4eefb159a6072677effd",
    name: "Caroline Business Standing Front",
    gender: "female",
    defaultVoiceId: "9e563ad72b8c43b087be6c98a60fb7f4",
  },
  {
    avatarId: "Chloe_standing_lounge_front",
    groupId: "1727655152",
    name: "Chloe Lounge Front",
    gender: "female",
    defaultVoiceId: "6e05e310c3f14ed4ba1545578ce82ff6",
  },
  {
    avatarId: "Derya_standing_office_front",
    groupId: "1726603925",
    name: "Derya Office Front 2",
    gender: "female",
    defaultVoiceId: "fe0398ef5b0f425ebfa90cd9ef00750a",
  },
  {
    avatarId: "Elenora_IT_Sitting_public",
    groupId: "1732660983",
    name: "Elenora Tech Expert",
    gender: "female",
    defaultVoiceId: "613f8304431144918ed6a83d4b3e3196",
  },
  {
    avatarId: "Georgia_sitting_office_front",
    groupId: "1727672614",
    name: "Georgia Office Front",
    gender: "female",
    defaultVoiceId: "7186e6c16ea840e9b78bd40c07ad20b0",
  },
  {
    avatarId: "Giulia_standing_office_front",
    groupId: "1727071025",
    name: "Giulia Office Front 2",
    gender: "female",
    defaultVoiceId: "d05627251174456fbf0b4f1542164d8d",
  },
  {
    avatarId: "Ida_standing_lounge_front",
    groupId: "1727400558",
    name: "Ida Lounge Front",
    gender: "female",
    defaultVoiceId: "16a09e4706f74997ba4ed05ea11470f6",
  },
  {
    avatarId: "Judy_Lawyer_Sitting2_public",
    groupId: "1732323320",
    name: "Judy Lawyer",
    gender: "female",
    defaultVoiceId: "b45b647c9a2649dba247ff275365df2c",
  },
  {
    avatarId: "June_HR_public",
    groupId: "1727686832",
    name: "June HR",
    gender: "female",
    defaultVoiceId: "f081135e72934ddc82d4e9a26b513f91",
  },
  {
    avatarId: "Kavya_standing_indoor_front",
    groupId: "1727719709",
    name: "Kavya Indoor Front",
    gender: "female",
    defaultVoiceId: "16a09e4706f74997ba4ed05ea11470f6",
  },
  {
    avatarId: "Mireia_sitting_businessindoor_front",
    groupId: "1727720778",
    name: "Mireia Business Indoor Front",
    gender: "female",
    defaultVoiceId: "712534c680f94736aa0f5b47e4b58da9",
  },
  {
    avatarId: "Bojan_standing_businesstraining_front",
    groupId: "1727650283",
    name: "Bojan Business Training Front",
    gender: "male",
    defaultVoiceId: "ba2015b057ca42bd8b8283b3f7ba5529",
  },
  {
    avatarId: "Brandon_Business_Standing_Front_public",
    groupId: "d08c85e6cff84d78b6dc41d83a2eccce",
    name: "Brandon Business Standing Front",
    gender: "male",
    defaultVoiceId: "513b14b431b64a578c467c480dd0a9c3",
  },
  {
    avatarId: "Emanuel_standing_office_front",
    groupId: "1727056509",
    name: "Emanuel Office Front",
    gender: "male",
    defaultVoiceId: "e13f92abd68a405e9ee9134a186d0706",
  },
  {
    avatarId: "Fernando_sitting_businessindoor_front",
    groupId: "1727657268",
    name: "Fernando Business Indoor Front",
    gender: "male",
    defaultVoiceId: "bad86f2c05d843c3901e110fbddbe86a",
  },
  {
    avatarId: "Gerardo_sitting_sofa_front",
    groupId: "1727662464",
    name: "Gerardo Sofa Front",
    gender: "male",
    defaultVoiceId: "eba73eba461b4655aa231ba342e3146b",
  },
  {
    avatarId: "Leos_sitting_sofa_front",
    groupId: "1727405873",
    name: "Leos Sofa Front",
    gender: "male",
    defaultVoiceId: "ee8521b42662428c84560d22954effe1",
  },
  {
    avatarId: "Leszek_sitting_sofa_front",
    groupId: "1727720732",
    name: "Leszek Sofa Front",
    gender: "male",
    defaultVoiceId: "cc6a378bd95c4421b9a2fcf1312c6ddb",
  },
  {
    avatarId: "Max_sitting_indoor_front",
    groupId: "1727705680",
    name: "Max Indoor Front",
    gender: "male",
    defaultVoiceId: "acfca8ab4b444e80a9df9e8e3a897cb4",
  },
  {
    avatarId: "Miles_sitting_sofa_front",
    groupId: "1727042161",
    name: "Miles Sofa Front 2",
    gender: "male",
    defaultVoiceId: "a5d0cef9f960416c8f5b970062ebb725",
  },
  {
    avatarId: "Patrizio_standing_businesstraining_front",
    groupId: "1727708884",
    name: "Patrizio Business Training Front",
    gender: "male",
    defaultVoiceId: "8445e1a518c74304bcaa5b793d1b2f54",
  },
  {
    avatarId: "Raul_Sitting_businesssofa_front_close",
    groupId: "1727698066",
    name: "Raul Business Sofa Front 2",
    gender: "male",
    defaultVoiceId: "791b008968c34a1797a50ba517c9e2dd",
  },
  {
    avatarId: "Riley_sitting_office_front",
    groupId: "1727693144",
    name: "Riley Office Front",
    gender: "male",
    defaultVoiceId: "0f6610678bfa4a1eb827d128662dca11",
  },
  {
    avatarId: "SilasHR_public",
    groupId: "1727684386",
    name: "Silas HR",
    gender: "male",
    defaultVoiceId: "08f561403ec846dbbd8c691cc448f45a",
  },
  {
    avatarId: "Timothy_sitting_office_front",
    groupId: "1727680915",
    name: "Timothy Office Front",
    gender: "male",
    defaultVoiceId: "f6d92a5cacc2425ea1fabfe3b79df31a",
  },
  {
    avatarId: "Vince_standing_businesstraining_front",
    groupId: "1727676442",
    name: "Vince Business Training Front",
    gender: "male",
    defaultVoiceId: "219a23d690fc48c7b3a24ea4a0ac651a",
  },
].map((avatar): HeyGenIntroVideoAvatar => {
  return {
    ...avatar,
    key: `heygen:${avatar.avatarId}`,
    provider: "heygen",
    previewWidth: 16,
    previewHeight: 9,
    preferredOrientation: "landscape",
    renderEngine: "avatar_iv",
    supportedApiEngines: HEYGEN_SUPPORTED_API_ENGINES,
    transparentBackgroundValidated: false,
  };
});

const HEYGEN_INTRO_VIDEO_AVATAR_IDS = new Set(
  HEYGEN_INTRO_VIDEO_AVATARS.map((avatar) => {
    return avatar.avatarId;
  }),
);

/** Whether a provider look is currently enabled in Intro Video's curation. */
export function isHeyGenIntroVideoAvatarId(avatarId: string): boolean {
  return HEYGEN_INTRO_VIDEO_AVATAR_IDS.has(avatarId);
}
