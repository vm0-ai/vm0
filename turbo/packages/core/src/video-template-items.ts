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
  readonly previewVideo: string;
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
  const previewVideo = VIDEO_TEMPLATE_PREVIEW_VIDEOS[slug];
  if (!previewVideo) {
    throw new Error(`Missing video template preview video: ${entry.id}`);
  }
  return {
    id: entry.id,
    slug,
    title: entry.name,
    description: entry.description,
    previewImage,
    previewVideo,
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
