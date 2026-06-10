export type VideoStyleCategory =
  | "anime_2d"
  | "art_culture"
  | "classic_cinematic"
  | "fashion_luxury"
  | "lifestyle"
  | "music_entertainment"
  | "nostalgic"
  | "product_brand"
  | "sci_fi_tech"
  | "sports_energy"
  | "surreal_creative"
  | "urban_social";

export type VideoStyleGroupTag =
  | "brand-product"
  | "story-emotion"
  | "energy-sports"
  | "fantasy-art"
  | "anime-2d";

export interface VideoStyleGroup {
  readonly tag: VideoStyleGroupTag;
  readonly label: string;
}

export const VIDEO_STYLE_GROUPS: readonly VideoStyleGroup[] = [
  { tag: "brand-product", label: "Brand & Product" },
  { tag: "story-emotion", label: "Story & Emotion" },
  { tag: "energy-sports", label: "Energy & Sports" },
  { tag: "fantasy-art", label: "Fantasy & Art" },
  { tag: "anime-2d", label: "Anime" },
];

export interface VideoStyleDimensions {
  readonly visualTone: string;
  readonly cameraStyle: string;
  readonly editingPace: string;
  readonly narrativeMode: string;
  readonly productionType: string;
  readonly emotionalTone: string;
  readonly styleReference: string;
}

export interface VideoStylePreset {
  readonly id: string;
  readonly nameZh: string;
  readonly nameEn: string;
  readonly category: VideoStyleCategory;
  readonly dimensions: VideoStyleDimensions;
  readonly scene: string;
  readonly sampleVideoUrl: string;
  readonly tags: readonly string[];
}

export const VIDEO_DIMENSION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  warm_natural: "soft, amber-toned naturalistic lighting",
  dreamy_pastel: "soft pastel palette with ethereal haze",
  cinematic: "high-contrast wide-format cinematic look",
  neon_cyberpunk: "electric neon glow against dark urban backdrops",
  muted_film_grain: "desaturated tones with visible film grain",
  high_contrast_bw: "stark black-and-white high-contrast monochrome",
  saturated_vivid: "punchy oversaturated color palette",
  vintage_warm: "golden-tinted warm vintage color grading",
  cool_blue: "cool-toned blue-grey cinematic palette",
  ink_wash: "Chinese ink wash monochrome aesthetic",
  flat_design: "flat minimalist graphic color palette",
  digital_glitch: "digital artifacts, scan lines, glitch aesthetics",
  anime_vibrant: "bright saturated anime-style color palette",
  pastel_soft: "gentle pastel tones, soft diffused light",
  earth_tones: "warm earthy browns, greens, ochres",
  steady_locked: "perfectly still, symmetrically composed locked frame",
  drone_aerial: "slow sweeping aerial drone shot",
  handheld_raw: "slightly shaky authentic handheld camera feel",
  dolly_smooth: "smooth cinematic dolly or slider movement",
  extreme_closeup: "tight macro shots emphasizing texture and detail",
  wide_establishing: "wide establishing shot, subjects small in environment",
  tracking_shot: "camera follows subject in smooth tracking motion",
  tilt_shift: "miniature effect with selective focus blur",
  fixed_medium: "fixed medium shot, subjects fill the frame",
  pov_firstperson: "immersive first-person point-of-view perspective",
  orbit_360: "360-degree orbital camera movement around subject",
  slow_meditative: "unhurried, contemplative long takes",
  fast_cut: "rapid rhythmic cuts synced to music",
  kinetic_energy: "high-energy quick cuts with motion blur",
  rhythmic_beat: "paced to a steady rhythmic beat with polished reveal moments",
  rhythmic_moderate: "moderate pacing with rhythmic editorial flow",
  jump_cut: "jump cuts creating energetic discontinuity",
  continuous_take: "long uninterrupted single-take sequence",
  montage_flow: "seamless montage with thematic flow",
  observational:
    "passive cinematic observation, no narrator, let visuals speak",
  voiceover_driven: "narrative driven by off-screen voice or text",
  character_driven: "story told through character reactions and behavior",
  problem_solution:
    "problem-solution structure that reveals a product as the answer",
  product_showcase: "direct showcase of product features and details",
  documentary_interview: "talking-head interview style documentary",
  abstract_visual: "pure visual storytelling without literal narrative",
  tutorial_guide: "step-by-step instructional or how-to format",
  live_action: "real-world live-action footage",
  "2d_animation": "hand-drawn or digital 2D animation",
  "3d_cgi": "computer-generated 3D imagery",
  stop_motion: "frame-by-frame stop-motion animation",
  mixed_media: "combination of live action and animation",
  screen_capture: "digital screen recording or UI demonstration",
  warm_nostalgic: "evokes comfort, memory, and warm nostalgia",
  epic_grand: "sweeping, awe-inspiring, grand emotional scale",
  playful_fun: "lighthearted, joyful, playful energy",
  inspiring: "motivational, uplifting, aspirational feeling",
  melancholic: "bittersweet longing, poetic sadness",
  serene_calm: "peaceful, meditative, tranquil atmosphere",
  euphoric_energy: "high-energy excitement and euphoric rush",
  mysterious: "enigmatic tension and atmospheric intrigue",
  cozy_intimate: "warm, close, domestic intimacy",
  wonder_awe: "childlike wonder and sense of discovery",
  intense_dramatic: "high-stakes emotional intensity",
  whimsical: "quirky, imaginative, fairy-tale whimsy",
  symmetrical_pastel_quirky:
    "Wes Anderson-esque deadpan symmetry with pastel palette",
  imax_epic_cinematic: "IMAX-scale epic with sweeping aerial scope",
  slowburn_moody_romance:
    "slow-burn atmospheric romance in the manner of arthouse cinema",
  indie_naturalistic:
    "indie naturalistic — raw handheld authenticity, available light",
  film_noir: "classic film noir — shadow, silhouette, moral ambiguity",
  tech_minimalist_reveal:
    "clean tech product reveal — white space, precision camera",
  apple_product:
    "Apple-style product commercial — premium materials, restrained motion, precise lighting",
  athletic_motivation_ad:
    "athletic motivation ad — kinetic energy, raw sweat, triumph",
  nature_documentary:
    "nature documentary — patient observation, macro detail, vast scale",
  shortform_viral:
    "short-form viral — fast hook, trending audio, authentic creator energy",
  hand_drawn_fantasy_anime:
    "hand-drawn fantasy anime — lush painterly backgrounds, expressive characters",
  chinese_ink_art:
    "Chinese ink wash — brushstroke elegance, negative space, classical poetry",
  pop_art: "pop art — bold flat colors, comic dots, graphic impact",
  japanese_wabi_sabi:
    "Japanese wabi-sabi — imperfection, aging, quiet beauty in impermanence",
  european_romance:
    "European arthouse romance — long glances, muted palettes, urban poetry",
  gourmet_documentary:
    "sensory-focused culinary documentary — texture, steam, artisan craft",
  fashion_editorial:
    "high fashion editorial — dramatic silhouettes, luxury materials",
  summer_indie:
    "golden hour indie summer — carefree golden light, handheld spontaneity",
  super8_home_film:
    "Super 8 home film — light leaks, dust grain, family nostalgia",
  cottagecore:
    "cottagecore pastoral — wildflower light, linen textures, rural idyll",
  wellness_yoga:
    "wellness lifestyle — clean white space, breath, mindful movement",
  diy_maker:
    "DIY maker — hands-on craft, workshop grit, creative problem-solving",
  extreme_sports_ad:
    "extreme sports ad — first-person rush, natural terrain, peak performance",
  music_video_narrative:
    "music video narrative — choreography, color story, artist performance",
  surrealist_dream:
    "surrealist dream — impossible gravity, melting forms, subconscious logic",
  ai_digital_art:
    "AI generative art — morphing geometry, luminous particles, data aesthetics",
  space_documentary:
    "space documentary — cosmic scale, hard science, human wonder",
  street_documentary:
    "street documentary — city pulse, candid portraits, social texture",
  synthwave_retro:
    "80s synthwave retro — grid horizons, neon glow, nostalgic retrofuturism",
  absurdist_comedy:
    "absurdist comedy — deadpan escalation, mundane surrealism, dry British wit",
  magical_girl_anime:
    "magical girl anime — sparkle transforms, friendship bonds, bright courage",
  shonen_battle_anime:
    "shonen battle anime — power-up determination, training montages, triumph",
  cyberpunk_anime:
    "cyberpunk anime — neon megacity, tech-augmented characters, dystopian beauty",
  slice_of_life_anime:
    "slice-of-life anime — everyday moments, soft season light, quiet emotion",
  wuxia_anime:
    "wuxia anime — wire-fu elegance, bamboo forests, honor and mastery",
};

export const VIDEO_STYLE_PRESETS: readonly VideoStylePreset[] = [
  {
    id: "symmetrical-pastel-quirky",
    nameZh: "对称粉彩·怪诞优雅",
    nameEn: "Symmetrical Pastel Quirky",
    category: "classic_cinematic",
    dimensions: {
      visualTone: "dreamy_pastel",
      cameraStyle: "steady_locked",
      editingPace: "slow_meditative",
      narrativeMode: "voiceover_driven",
      productionType: "live_action",
      emotionalTone: "playful_fun",
      styleReference: "symmetrical_pastel_quirky",
    },
    scene: "grand-hotel-lobby",
    sampleVideoUrl: "",
    tags: ["story-emotion", "quirky", "pastel", "symmetry", "deadpan", "retro"],
  },
  {
    id: "imax-epic-cinematic",
    nameZh: "史诗叙事·宏大电影",
    nameEn: "IMAX Epic Cinematic",
    category: "classic_cinematic",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "drone_aerial",
      editingPace: "slow_meditative",
      narrativeMode: "voiceover_driven",
      productionType: "live_action",
      emotionalTone: "epic_grand",
      styleReference: "imax_epic_cinematic",
    },
    scene: "mountain-horizon",
    sampleVideoUrl: "",
    tags: ["story-emotion", "epic", "imax", "dramatic", "cinematic", "grand"],
  },
  {
    id: "slowburn-moody-romance",
    nameZh: "情绪诗意·慢燃暖光",
    nameEn: "Slow Burn Moody Romance",
    category: "classic_cinematic",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "handheld_raw",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "melancholic",
      styleReference: "slowburn_moody_romance",
    },
    scene: "rain-on-window",
    sampleVideoUrl: "",
    tags: [
      "story-emotion",
      "moody",
      "romance",
      "handheld",
      "nostalgic",
      "atmospheric",
    ],
  },
  {
    id: "indie-naturalistic",
    nameZh: "文艺独立·自然光",
    nameEn: "Indie Naturalistic",
    category: "classic_cinematic",
    dimensions: {
      visualTone: "cold_desaturated",
      cameraStyle: "handheld_raw",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "melancholic",
      styleReference: "indie_naturalistic",
    },
    scene: "forest-clearing",
    sampleVideoUrl: "",
    tags: [
      "story-emotion",
      "indie",
      "arthouse",
      "naturalistic",
      "quiet",
      "character-driven",
    ],
  },
  {
    id: "film-noir",
    nameZh: "黑白悬疑·Film Noir",
    nameEn: "Film Noir",
    category: "classic_cinematic",
    dimensions: {
      visualTone: "cold_desaturated",
      cameraStyle: "steady_locked",
      editingPace: "slow_meditative",
      narrativeMode: "voiceover_driven",
      productionType: "live_action",
      emotionalTone: "melancholic",
      styleReference: "film_noir",
    },
    scene: "rain-on-window",
    sampleVideoUrl: "",
    tags: [
      "story-emotion",
      "noir",
      "black-white",
      "mystery",
      "shadows",
      "1950s",
    ],
  },
  {
    id: "tech-minimalist-reveal",
    nameZh: "极简科技·产品展示",
    nameEn: "Tech Minimalist Reveal",
    category: "product_brand",
    dimensions: {
      visualTone: "cold_desaturated",
      cameraStyle: "slow_push_in",
      editingPace: "slow_meditative",
      narrativeMode: "abstract_mood",
      productionType: "live_action",
      emotionalTone: "inspiring",
      styleReference: "tech_minimalist_reveal",
    },
    scene: "laptop-open",
    sampleVideoUrl: "",
    tags: ["brand-product", "minimalist", "product", "tech", "clean", "white"],
  },
  {
    id: "luxury-watch-product",
    nameZh: "Luxury Watch Product",
    nameEn: "Luxury Watch Product",
    category: "product_brand",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "steady_locked",
      editingPace: "rhythmic_beat",
      narrativeMode: "problem_solution",
      productionType: "live_action",
      emotionalTone: "inspiring",
      styleReference: "apple_product",
    },
    scene: "luxury-watch-dial",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e20abbb-a630-4523-857f-8350eba2ea4f/video-9e20abbb.mp4",
    tags: [
      "brand-product",
      "product",
      "watch",
      "luxury",
      "mechanical-watch",
      "apple-product",
      "cinematic",
    ],
  },
  {
    id: "athletic-motivation",
    nameZh: "运动励志·广告风",
    nameEn: "Athletic Motivation Ad",
    category: "sports_energy",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "extreme_closeup",
      editingPace: "fast_cut",
      narrativeMode: "linear_story",
      productionType: "live_action",
      emotionalTone: "inspiring",
      styleReference: "athletic_motivation_ad",
    },
    scene: "extreme-sports",
    sampleVideoUrl: "",
    tags: ["energy-sports", "sports", "motivation", "fast", "energy", "ad"],
  },
  {
    id: "nature-documentary",
    nameZh: "自然纪录·BBC风",
    nameEn: "Nature Documentary",
    category: "sci_fi_tech",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "drone_aerial",
      editingPace: "slow_meditative",
      narrativeMode: "voiceover_driven",
      productionType: "live_action",
      emotionalTone: "calm_meditative",
      styleReference: "nature_documentary",
    },
    scene: "mountain-horizon",
    sampleVideoUrl: "",
    tags: [
      "story-emotion",
      "nature",
      "documentary",
      "wildlife",
      "slow",
      "cinematic",
    ],
  },
  {
    id: "shortform-viral",
    nameZh: "短视频·病毒传播",
    nameEn: "Shortform Viral",
    category: "urban_social",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "handheld_raw",
      editingPace: "fast_cut",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "playful_fun",
      styleReference: "shortform_viral",
    },
    scene: "summer-beach-crew",
    sampleVideoUrl: "",
    tags: ["energy-sports", "viral", "shortform", "trending", "fast", "social"],
  },
  {
    id: "hand-drawn-fantasy-anime",
    nameZh: "手绘奇幻·动漫美学",
    nameEn: "Hand Drawn Fantasy Anime",
    category: "anime_2d",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "slow_push_in",
      editingPace: "slow_meditative",
      narrativeMode: "linear_story",
      productionType: "2d_animation",
      emotionalTone: "playful_fun",
      styleReference: "hand_drawn_fantasy_anime",
    },
    scene: "forest-spirit-path",
    sampleVideoUrl: "",
    tags: [
      "fantasy-art",
      "anime",
      "hand-drawn",
      "fantasy",
      "nature",
      "whimsical",
    ],
  },
  {
    id: "chinese-ink-art",
    nameZh: "水墨·东方禅意",
    nameEn: "Chinese Ink Painting",
    category: "art_culture",
    dimensions: {
      visualTone: "cold_desaturated",
      cameraStyle: "slow_push_in",
      editingPace: "slow_meditative",
      narrativeMode: "abstract_mood",
      productionType: "live_action",
      emotionalTone: "calm_meditative",
      styleReference: "chinese_ink",
    },
    scene: "mountain-horizon",
    sampleVideoUrl: "",
    tags: ["fantasy-art", "ink", "chinese", "zen", "minimalist", "eastern"],
  },
  {
    id: "pop-art",
    nameZh: "波普·安迪沃霍尔风",
    nameEn: "Pop Art",
    category: "art_culture",
    dimensions: {
      visualTone: "neon_cyberpunk",
      cameraStyle: "steady_locked",
      editingPace: "fast_cut",
      narrativeMode: "abstract_mood",
      productionType: "live_action",
      emotionalTone: "playful_fun",
      styleReference: "pop_art",
    },
    scene: "abstract-color-burst",
    sampleVideoUrl: "",
    tags: ["fantasy-art", "pop-art", "bold", "colorful", "graphic", "retro"],
  },
  {
    id: "japanese-wabi-sabi",
    nameZh: "日系·小清新",
    nameEn: "Japanese Wabi-Sabi",
    category: "art_culture",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "slow_push_in",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "calm_meditative",
      styleReference: "japanese_wabi_sabi",
    },
    scene: "tokyo-alley-morning",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f06bf43d-4820-466f-bc1d-716dec01e3cc/video-f06bf43d.mp4",
    tags: [
      "story-emotion",
      "japanese",
      "wabi-sabi",
      "calm",
      "everyday",
      "aesthetic",
    ],
  },
  {
    id: "european-romance",
    nameZh: "欧洲·古典浪漫",
    nameEn: "European Classical Romance",
    category: "art_culture",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "steady_locked",
      editingPace: "slow_meditative",
      narrativeMode: "voiceover_driven",
      productionType: "live_action",
      emotionalTone: "warm_nostalgic",
      styleReference: "european_romance",
    },
    scene: "castle-garden-dusk",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8ea3c41f-8e80-4c70-aae6-a492b9eb264e/video-8ea3c41f.mp4",
    tags: [
      "story-emotion",
      "europe",
      "romance",
      "castle",
      "golden-hour",
      "elegant",
    ],
  },
  {
    id: "gourmet-documentary",
    nameZh: "美食纪录·感官系",
    nameEn: "Gourmet Documentary",
    category: "lifestyle",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "extreme_closeup",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "warm_nostalgic",
      styleReference: "gourmet_documentary",
    },
    scene: "food-plating",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3f0dd8d7-bfc3-4443-9b95-b58faf0d4f64/video-3f0dd8d7.mp4",
    tags: ["brand-product", "food", "macro", "sensory", "chef", "documentary"],
  },
  {
    id: "fashion-editorial",
    nameZh: "奢侈品·时尚大片",
    nameEn: "Fashion Editorial",
    category: "fashion_luxury",
    dimensions: {
      visualTone: "cold_desaturated",
      cameraStyle: "steady_locked",
      editingPace: "slow_meditative",
      narrativeMode: "abstract_mood",
      productionType: "live_action",
      emotionalTone: "epic_grand",
      styleReference: "fashion_editorial",
    },
    scene: "model-editorial",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6024a53b-fe0c-45dc-b5df-0ae14ad883ed/video-6024a53b.mp4",
    tags: [
      "brand-product",
      "fashion",
      "luxury",
      "editorial",
      "high-contrast",
      "model",
    ],
  },
  {
    id: "summer-indie",
    nameZh: "夏日·清新活力",
    nameEn: "Summer Indie",
    category: "lifestyle",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "handheld_raw",
      editingPace: "fast_cut",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "playful_fun",
      styleReference: "summer_indie",
    },
    scene: "summer-beach-crew",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d44e690-d838-49c6-89f8-946bcffee10b/video-3d44e690.mp4",
    tags: ["energy-sports", "summer", "beach", "youth", "vibrant", "friends"],
  },
  {
    id: "super8-home-film",
    nameZh: "复古暖调·70s胶片",
    nameEn: "Super 8 Home Film",
    category: "nostalgic",
    dimensions: {
      visualTone: "vintage_film",
      cameraStyle: "handheld_raw",
      editingPace: "slow_meditative",
      narrativeMode: "voiceover_driven",
      productionType: "live_action",
      emotionalTone: "warm_nostalgic",
      styleReference: "super8_home_film",
    },
    scene: "family-backyard-70s",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/29ddb4de-8aef-42a7-aac4-ee013c9272a5/video-29ddb4de.mp4",
    tags: [
      "story-emotion",
      "retro",
      "70s",
      "super8",
      "family",
      "nostalgic",
      "film-grain",
    ],
  },
  {
    id: "cottagecore",
    nameZh: "Cottagecore 田园乡村",
    nameEn: "Cottagecore",
    category: "lifestyle",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "slow_push_in",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "warm_nostalgic",
      styleReference: "cottagecore",
    },
    scene: "cottage-garden-morning",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c28fd30a-d735-4c67-97d4-0567fd375a8d/video-c28fd30a.mp4",
    tags: [
      "story-emotion",
      "cottagecore",
      "garden",
      "handmade",
      "nature",
      "cozy",
      "slow-living",
    ],
  },
  {
    id: "wellness-yoga",
    nameZh: "Wellness 瑜伽冥想",
    nameEn: "Wellness & Yoga",
    category: "lifestyle",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "slow_push_in",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "calm_meditative",
      styleReference: "wellness_yoga",
    },
    scene: "yoga-sunrise-studio",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b629a3f5-c644-4d96-81f5-834fe1a31da1/video-b629a3f5.mp4",
    tags: [
      "brand-product",
      "wellness",
      "yoga",
      "meditation",
      "mindfulness",
      "morning",
      "calm",
    ],
  },
  {
    id: "diy-maker",
    nameZh: "DIY Maker 手作文化",
    nameEn: "DIY Maker Culture",
    category: "lifestyle",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "extreme_closeup",
      editingPace: "rhythmic_beat",
      narrativeMode: "linear_story",
      productionType: "live_action",
      emotionalTone: "inspiring",
      styleReference: "diy_maker",
    },
    scene: "workshop-maker-build",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/76c1cf86-cb76-4a9b-817f-15597bcc8481/video-76c1cf86.mp4",
    tags: [
      "brand-product",
      "diy",
      "maker",
      "craft",
      "woodwork",
      "handmade",
      "satisfying",
    ],
  },
  {
    id: "extreme-sports",
    nameZh: "运动·高燃热血",
    nameEn: "Extreme Sports Ad",
    category: "sports_energy",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "extreme_closeup",
      editingPace: "rhythmic_beat",
      narrativeMode: "linear_story",
      productionType: "live_action",
      emotionalTone: "inspiring",
      styleReference: "extreme_sports_ad",
    },
    scene: "extreme-sports",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/305b6781-280a-4f07-927a-1191bd8ece9b/video-305b6781.mp4",
    tags: [
      "energy-sports",
      "extreme-sports",
      "action",
      "adrenaline",
      "slow-motion",
      "athlete",
    ],
  },
  {
    id: "music-video",
    nameZh: "音乐MV风",
    nameEn: "Music Video",
    category: "music_entertainment",
    dimensions: {
      visualTone: "neon_cyberpunk",
      cameraStyle: "dutch_angle",
      editingPace: "rhythmic_beat",
      narrativeMode: "abstract_mood",
      productionType: "live_action",
      emotionalTone: "playful_fun",
      styleReference: "music_video_mv",
    },
    scene: "concert-stage",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f7d288e2-9d81-43b7-ae1b-1702a11686a8/video-f7d288e2.mp4",
    tags: [
      "energy-sports",
      "music",
      "concert",
      "stage",
      "neon",
      "performance",
      "rhythm",
    ],
  },
  {
    id: "surrealist-dream",
    nameZh: "超现实·梦境",
    nameEn: "Surrealist Dream",
    category: "surreal_creative",
    dimensions: {
      visualTone: "dreamy_pastel",
      cameraStyle: "slow_push_in",
      editingPace: "seamless_flow",
      narrativeMode: "abstract_mood",
      productionType: "mixed_media",
      emotionalTone: "melancholic",
      styleReference: "surrealist_dream",
    },
    scene: "impossible-room",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b7b0d289-9e05-4f93-9795-d5d19263435c/video-b7b0d289.mp4",
    tags: ["fantasy-art", "surreal", "dream", "impossible", "dali", "ethereal"],
  },
  {
    id: "ai-digital-art",
    nameZh: "AI·数字宇宙",
    nameEn: "AI Digital Universe",
    category: "sci_fi_tech",
    dimensions: {
      visualTone: "neon_cyberpunk",
      cameraStyle: "pov_firstperson",
      editingPace: "fast_cut",
      narrativeMode: "abstract_mood",
      productionType: "3d_cgi",
      emotionalTone: "inspiring",
      styleReference: "ai_digital_art",
    },
    scene: "neural-network-viz",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/629cab0a-fead-4c9c-ac9b-d5ef6df0782f/video-629cab0a.mp4",
    tags: [
      "fantasy-art",
      "ai",
      "digital",
      "neural-network",
      "futuristic",
      "code",
      "tech",
    ],
  },
  {
    id: "space-documentary",
    nameZh: "太空·宇宙探索",
    nameEn: "Space Documentary",
    category: "sci_fi_tech",
    dimensions: {
      visualTone: "cold_desaturated",
      cameraStyle: "drone_aerial",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "epic_grand",
      styleReference: "space_documentary",
    },
    scene: "astronaut-spacewalk",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/273d9673-9ed2-426b-8516-0102fbdd8622/video-273d9673.mp4",
    tags: [
      "story-emotion",
      "space",
      "cosmos",
      "nasa",
      "astronaut",
      "epic",
      "documentary",
    ],
  },
  {
    id: "street-documentary",
    nameZh: "街头纪实·都市",
    nameEn: "Street Documentary",
    category: "urban_social",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "handheld_raw",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "melancholic",
      styleReference: "street_documentary",
    },
    scene: "nyc-street-corner",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/54c271a6-d2da-4134-a812-679fd0fc8810/video-54c271a6.mp4",
    tags: [
      "story-emotion",
      "street",
      "nyc",
      "urban",
      "documentary",
      "people",
      "authentic",
    ],
  },
  {
    id: "synthwave-retro",
    nameZh: "80s Synthwave·复古科技",
    nameEn: "Synthwave Retro",
    category: "nostalgic",
    dimensions: {
      visualTone: "neon_cyberpunk",
      cameraStyle: "steady_locked",
      editingPace: "rhythmic_beat",
      narrativeMode: "abstract_mood",
      productionType: "live_action",
      emotionalTone: "warm_nostalgic",
      styleReference: "synthwave_retro",
    },
    scene: "neon-highway-night",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c227b1aa-7876-4fe3-8869-4d2b996d418f/video-c227b1aa.mp4",
    tags: [
      "fantasy-art",
      "synthwave",
      "80s",
      "retro",
      "neon",
      "vhs",
      "cyberpunk-nostalgic",
    ],
  },
  {
    id: "absurdist-comedy",
    nameZh: "怪诞喜剧·冷面幽默",
    nameEn: "Absurdist Comedy",
    category: "surreal_creative",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "handheld_raw",
      editingPace: "fast_cut",
      narrativeMode: "observational",
      productionType: "live_action",
      emotionalTone: "humorous_quirky",
      styleReference: "absurdist_comedy",
    },
    scene: "mundane-surreal-office",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e93201b0-90d2-42f1-9db7-19441315c4bc/video-e93201b0.mp4",
    tags: [
      "fantasy-art",
      "comedy",
      "absurdist",
      "quirky",
      "deadpan",
      "office",
      "humor",
    ],
  },
  {
    id: "magical-girl",
    nameZh: "魔法少女·粉彩变身",
    nameEn: "Magical Girl",
    category: "anime_2d",
    dimensions: {
      visualTone: "dreamy_pastel",
      cameraStyle: "slow_push_in",
      editingPace: "seamless_flow",
      narrativeMode: "linear_story",
      productionType: "2d_animation",
      emotionalTone: "playful_fun",
      styleReference: "magical_girl",
    },
    scene: "magical-girl-transform",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f0b7f984-4d85-432f-bf41-a53d89e262bd/video-f0b7f984.mp4",
    tags: [
      "anime-2d",
      "anime",
      "magical-girl",
      "transformation",
      "pastel",
      "sparkle",
    ],
  },
  {
    id: "shonen-battle",
    nameZh: "热血少年·觉醒爆发",
    nameEn: "Shonen Battle",
    category: "anime_2d",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "extreme_closeup",
      editingPace: "rhythmic_beat",
      narrativeMode: "linear_story",
      productionType: "2d_animation",
      emotionalTone: "inspiring",
      styleReference: "shonen_battle",
    },
    scene: "hero-power-awakening",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d07d39ed-d2fe-4bee-a148-501d96ead5a2/video-d07d39ed.mp4",
    tags: [
      "anime-2d",
      "anime",
      "shonen",
      "battle",
      "power-up",
      "energy",
      "hero",
    ],
  },
  {
    id: "cyberpunk-anime",
    nameZh: "赛博朋克·动漫都市",
    nameEn: "Cyberpunk Anime",
    category: "anime_2d",
    dimensions: {
      visualTone: "neon_cyberpunk",
      cameraStyle: "dutch_angle",
      editingPace: "fast_cut",
      narrativeMode: "abstract_mood",
      productionType: "2d_animation",
      emotionalTone: "melancholic",
      styleReference: "cyberpunk_anime",
    },
    scene: "cyberpunk-hacker-alley",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e1cfe984-3bfc-4ba1-acb3-9b40b7b76771/video-e1cfe984.mp4",
    tags: [
      "anime-2d",
      "anime",
      "cyberpunk",
      "neon",
      "hacker",
      "dystopian",
      "futuristic",
    ],
  },
  {
    id: "slice-of-life-anime",
    nameZh: "日常系·校园治愈",
    nameEn: "Slice of Life Anime",
    category: "anime_2d",
    dimensions: {
      visualTone: "warm_natural",
      cameraStyle: "slow_push_in",
      editingPace: "slow_meditative",
      narrativeMode: "observational",
      productionType: "2d_animation",
      emotionalTone: "playful_fun",
      styleReference: "slice_of_life_anime",
    },
    scene: "school-summer-afternoon",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a477b387-f156-4826-9112-3258fcaec339/video-a477b387.mp4",
    tags: [
      "anime-2d",
      "anime",
      "slice-of-life",
      "school",
      "healing",
      "summer",
      "friends",
    ],
  },
  {
    id: "wuxia-anime",
    nameZh: "古风仙侠·国漫",
    nameEn: "Wuxia Anime",
    category: "anime_2d",
    dimensions: {
      visualTone: "cinematic",
      cameraStyle: "drone_aerial",
      editingPace: "seamless_flow",
      narrativeMode: "linear_story",
      productionType: "2d_animation",
      emotionalTone: "epic_grand",
      styleReference: "wuxia_anime",
    },
    scene: "wuxia-sword-flight",
    sampleVideoUrl:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/939b77ca-c2f2-4379-abfa-1bb2a904288b/video-939b77ca.mp4",
    tags: [
      "anime-2d",
      "anime",
      "wuxia",
      "chinese-animation",
      "sword",
      "ancient",
      "epic",
      "ink-wash",
    ],
  },
];
