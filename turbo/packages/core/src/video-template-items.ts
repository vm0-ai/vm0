import {
  findVideoTemplate,
  listVideoTemplates,
  type VideoTemplateRegistryEntry,
} from "./resource-registry";

export interface VideoTemplateItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly previewImage: string;
  readonly cardPreviewImage?: string;
  readonly previewVideo: string;
  readonly previewWebm: string;
  readonly sourcePath: string;
}

const VIDEO_TEMPLATE_PREVIEW_IMAGES: Readonly<Record<string, string>> = {
  "chinese-ink-art":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/35a45e0a-095f-476c-9586-840b3e591947/thumbnail-chinese-ink-art.jpg",
  "cyberpunk-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b870f6c1-95a8-4ab6-aa0d-a125cb57dd3e/thumbnail-cyberpunk-anime.jpg",
  "epic-grandeur":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2c0eb943-f65a-4225-beaa-78246f7c4a1b/thumbnail-imax-epic-cinematic.jpg",
  "fashion-editorial":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/31026908-c354-4cb5-a51b-8ac8e12ac910/thumbnail-fashion-editorial.jpg",
  "gourmet-documentary":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/30ab1733-bec0-4ddb-9e15-8f707377af7b/thumbnail-gourmet-documentary.jpg",
  "hand-drawn-fantasy-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ad08022e-5b28-4e80-a67f-cbe5d27cbc03/thumbnail-hand-drawn-fantasy-anime.jpg",
  "japanese-wabi-sabi":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a7a69fe3-9e6c-48fd-af55-62c8a57a0371/thumbnail-japanese-wabi-sabi.jpg",
  "luxury-product":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/016fd6d1-05d9-4709-a7d8-0799409fa1d9/thumbnail-luxury-watch-product.jpg",
  "shortform-viral":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/40ab801f-16bc-4e29-8370-6b10cd394e30/thumbnail-shortform-viral.jpg",
  "sports-performance-ad":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5a95669a-b86c-4817-9d82-250da7509b54/thumbnail-athletic-motivation.jpg",
};

const VIDEO_TEMPLATE_CARD_PREVIEW_IMAGES: Readonly<Record<string, string>> = {
  "epic-grandeur":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9ad13726-9151-4c68-b89d-afbe90c949bb/template-card-video-epic-grandeur-480x270.jpg",
  "gourmet-documentary":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/37cffe87-de56-4a53-bddc-b8f43f97b260/template-card-video-gourmet-documentary-480x270.jpg",
  "luxury-product":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9726e1d9-f08e-4a94-b823-2b1f89bc382d/template-card-video-luxury-product-480x270.jpg",
  "shortform-viral":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2d798f24-325f-4185-9a01-28b3faa3950f/template-card-video-shortform-viral-480x270.jpg",
  "fashion-editorial":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fa629d39-bf4f-433c-ad87-7385aa05700b/template-card-video-fashion-editorial-480x270.jpg",
  "sports-performance-ad":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/91cf5878-1b6f-468c-82e1-4d59a99fccae/template-card-video-sports-performance-ad-480x270.jpg",
  "japanese-wabi-sabi":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/07d4529e-d9ed-43dd-bf13-c2f6ac253476/template-card-video-japanese-wabi-sabi-480x270.jpg",
  "hand-drawn-fantasy-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/82204005-e01a-47de-9120-e533e992b290/template-card-video-hand-drawn-fantasy-anime-480x270.jpg",
  "cyberpunk-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1d690a29-2be1-404b-9698-638f18685513/template-card-video-cyberpunk-anime-480x270.jpg",
  "chinese-ink-art":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0bad21ee-4b92-4ea0-ad15-5453573aad7b/template-card-video-chinese-ink-art-480x270.jpg",
};

const VIDEO_TEMPLATE_PREVIEW_VIDEOS: Readonly<Record<string, string>> = {
  "chinese-ink-art":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8314b0ae-6051-4daa-b789-51bec466ba66/video-8314b0ae.mp4",
  "cyberpunk-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e1cfe984-3bfc-4ba1-acb3-9b40b7b76771/video-e1cfe984.mp4",
  "epic-grandeur":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/df99de74-8eea-420c-86d1-c104ba5ba6b6/video-df99de74.mp4",
  "fashion-editorial":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8bf8b826-2517-435b-8882-7f071c683e46/video-8bf8b826.mp4",
  "gourmet-documentary":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3f0dd8d7-bfc3-4443-9b95-b58faf0d4f64/video-3f0dd8d7.mp4",
  "hand-drawn-fantasy-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/da7c7c2d-3383-4796-8e83-b0e112127387/video-da7c7c2d.mp4",
  "japanese-wabi-sabi":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/72b754cf-f76d-4fa9-9015-ab5082b49608/video-72b754cf.mp4",
  "luxury-product":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e20abbb-a630-4523-857f-8350eba2ea4f/video-9e20abbb.mp4",
  "shortform-viral":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4bac1319-dba7-47a0-bc1b-4d1e932f71fd/video-4bac1319.mp4",
  "sports-performance-ad":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/104ad36a-4d0c-472b-8416-d04cc2f06e75/video-104ad36a.mp4",
};

const VIDEO_TEMPLATE_PREVIEW_WEBMS: Readonly<Record<string, string>> = {
  "chinese-ink-art":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b18f8d3e-22c9-468f-817e-2046d134fcf6/chinese-ink-art.webm",
  "cyberpunk-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cf8ab683-7c7e-4cfd-b9f2-44eec893407e/cyberpunk-anime.webm",
  "epic-grandeur":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e8b67299-f944-4942-a727-931026dea2a0/epic-grandeur.webm",
  "fashion-editorial":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/51e93c96-03be-4d5a-a66c-b90ec6c52111/fashion-editorial.webm",
  "gourmet-documentary":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3b39aeed-30be-4e79-8a6a-23ffd76fca86/gourmet-documentary.webm",
  "hand-drawn-fantasy-anime":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/42f6fb38-6544-4e42-ba4d-5dd352da9051/hand-drawn-fantasy-anime.webm",
  "japanese-wabi-sabi":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/22d6c8cb-b7f0-40f7-9c5f-022e578a060b/japanese-wabi-sabi.webm",
  "luxury-product":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1ad1c730-d146-4bf5-9936-dea198c593ec/luxury-product.webm",
  "shortform-viral":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0b1dbbb8-782e-451d-87e9-6652f60116bf/shortform-viral.webm",
  "sports-performance-ad":
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a6dab950-dddc-4116-9bc3-624265b35c12/sports-performance-ad.webm",
};

function videoTemplateSlug(entry: VideoTemplateRegistryEntry): string {
  return entry.id.replace(/^video-template:/u, "");
}

function toVideoTemplateItem(
  entry: VideoTemplateRegistryEntry,
): VideoTemplateItem {
  const slug = videoTemplateSlug(entry);
  const previewImage = VIDEO_TEMPLATE_PREVIEW_IMAGES[slug];
  if (!previewImage) {
    throw new Error(`Missing video template preview image: ${entry.id}`);
  }
  const cardPreviewImage = VIDEO_TEMPLATE_CARD_PREVIEW_IMAGES[slug];
  if (!cardPreviewImage) {
    throw new Error(`Missing video template card preview image: ${entry.id}`);
  }
  const previewVideo = VIDEO_TEMPLATE_PREVIEW_VIDEOS[slug];
  if (!previewVideo) {
    throw new Error(`Missing video template preview video: ${entry.id}`);
  }
  const previewWebm = VIDEO_TEMPLATE_PREVIEW_WEBMS[slug];
  if (!previewWebm) {
    throw new Error(`Missing video template preview webm: ${entry.id}`);
  }
  return {
    id: entry.id,
    slug,
    title: entry.name,
    description: entry.description,
    previewImage,
    cardPreviewImage,
    previewVideo,
    previewWebm,
    sourcePath: entry.source.path,
  };
}

export const VIDEO_TEMPLATE_ITEMS: readonly VideoTemplateItem[] =
  listVideoTemplates().map(toVideoTemplateItem);

export function findVideoTemplateItem(
  id: string,
): VideoTemplateItem | undefined {
  const entry = findVideoTemplate(id);
  if (!entry) {
    return undefined;
  }
  return VIDEO_TEMPLATE_ITEMS.find((item) => {
    return item.id === entry.id;
  });
}
