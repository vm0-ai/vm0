export interface PresentationTemplateItem {
  readonly slug: string;
  readonly title: string;
  readonly prompt: string;
  readonly embedUrl: string;
  readonly previewImage: string;
  readonly previewImages: readonly string[];
  readonly slideCount?: number;
  readonly cardPreviewImage?: string;
  readonly cardPreviewImagesByTheme?: Readonly<Record<string, string>>;
  readonly previewHtmls?: readonly string[];
  readonly colorSystemId?: string;
  readonly designSystemId: string;
  readonly templateId: string;
}

export const PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES = [
  "prism",
  "carnival",
  "pop-art",
  "warm-sand",
  "bauhaus-primary",
  "nordic-frost",
  "forest-editorial",
  "coral-studio",
  "slate-corporate",
  "terracotta-clay",
  "berry-pop",
  "citrus-fresh",
  "mauve-dusk",
  "mono-ink",
  "sunset-maroon",
  "mint-tech",
  "midnight-mono",
  "ocean-deep",
  "gold-luxe",
] as const;

const PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES = {
  "playful-launch-presentation": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e516bfce-08dd-44c2-aeef-a7cab1ffb1f1/template-card-presentation-playful-launch-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e96ec7bc-bc0c-432f-a617-69aac96dbd76/template-card-presentation-playful-launch-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/df5b4d27-0018-422a-9d16-e36969f5bc6a/template-card-presentation-playful-launch-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/42b9f430-fe8f-4d16-a49e-45f99ae8a059/template-card-presentation-playful-launch-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/01f032ec-30dd-41de-9d1f-405eb27cc308/template-card-presentation-playful-launch-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/46686b18-0e43-4563-a73a-f05bb4966084/template-card-presentation-playful-launch-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ef757d22-ea0e-4581-9592-cf113c4216f0/template-card-presentation-playful-launch-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/711f48e7-d9fd-499d-9731-d40810c38492/template-card-presentation-playful-launch-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62d80ba3-b008-44f5-bf04-4eb5a7893191/template-card-presentation-playful-launch-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/af1a6390-86b2-4800-8bc5-f1764ffbeb94/template-card-presentation-playful-launch-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/380de217-d30a-45af-8a12-b81a0a002cfd/template-card-presentation-playful-launch-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c7c72f5e-8d28-4a49-a5c3-ea41e57c8c19/template-card-presentation-playful-launch-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/277b8cba-0a28-491b-b957-27362b8e902e/template-card-presentation-playful-launch-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/da108e93-faed-4d55-a992-a8b2e3347a66/template-card-presentation-playful-launch-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2fef9c56-6730-42ea-a037-f9dd52cd1f74/template-card-presentation-playful-launch-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f86ce9c2-8127-4903-847d-c9941986f3f1/template-card-presentation-playful-launch-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3e9e3fbc-8ab6-466e-bd23-6cfaf6c4f471/template-card-presentation-playful-launch-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/21ab7eb6-f409-4143-8402-71e70b8cdbf0/template-card-presentation-playful-launch-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6d5be839-0844-4632-95e7-c8307b994a81/template-card-presentation-playful-launch-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "botane-organic-deck": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e19e33e-6c1a-4e3d-bb5d-9de1b154a61b/template-card-presentation-botane-organic-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d923c670-256d-427f-b720-dfa03f523090/template-card-presentation-botane-organic-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9470f2f5-191f-4245-9494-c64b0f5e2acc/template-card-presentation-botane-organic-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/65e100da-419a-4cbf-99dd-90ccbb1e6bd0/template-card-presentation-botane-organic-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/99920d9a-a837-4554-9ed6-0c45371b2fea/template-card-presentation-botane-organic-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ee0b8ab9-1801-4a87-8973-f01da391273b/template-card-presentation-botane-organic-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d8679bb0-8b89-496c-8e85-9b95308fe79e/template-card-presentation-botane-organic-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b2bfb2e7-4418-4f6a-933e-8924885e3da2/template-card-presentation-botane-organic-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e13c87d6-ecb6-4e0b-a32a-25d3d70aab45/template-card-presentation-botane-organic-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1e936869-7aee-453e-b5c5-fd9792bdca5d/template-card-presentation-botane-organic-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b5a371cd-1972-42df-b6b9-afb23c10d321/template-card-presentation-botane-organic-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62e8e14d-5d40-43c8-ace5-e2cfa4447bc5/template-card-presentation-botane-organic-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/59ac5cad-a182-4fe1-bf5f-84011d92caa7/template-card-presentation-botane-organic-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/816202cb-5e4d-4e0a-a988-71e9861f0675/template-card-presentation-botane-organic-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/50a496c0-cefc-4800-a926-54603b064d49/template-card-presentation-botane-organic-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4e9cb042-170c-4bb0-ae27-1170e665d696/template-card-presentation-botane-organic-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5e5588e4-28c0-49f3-8b41-a3051e7efcb2/template-card-presentation-botane-organic-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/68275cfe-5d08-4347-8515-933c543daf98/template-card-presentation-botane-organic-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e515fa02-9789-476e-a0fa-9888864563cb/template-card-presentation-botane-organic-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "business-data-presentation": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7422d136-aeba-4fb9-b2d2-001f6022ad7d/template-card-presentation-business-data-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/802d61cd-44c3-462b-8065-eb34f1c81fff/template-card-presentation-business-data-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9af0a230-679d-4b98-89d1-1634f3505dd3/template-card-presentation-business-data-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/36d944ce-548c-48ac-8d20-ef9789854cc9/template-card-presentation-business-data-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1b0a0751-3157-423d-8359-11fa404c1388/template-card-presentation-business-data-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/69524f5b-e966-42fd-a2b2-f66cd73765d6/template-card-presentation-business-data-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0bde4d93-1886-4c93-bcf1-063a1e69a86c/template-card-presentation-business-data-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fd2284ea-0f30-4d15-8cde-63ae0edd3c0a/template-card-presentation-business-data-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/594f59da-1ae0-42e3-ac01-97af7f7ec88a/template-card-presentation-business-data-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/791304f7-952e-4862-8209-2dd8e6735253/template-card-presentation-business-data-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/93c20663-bbf8-4ae2-b587-0dc4a7c75292/template-card-presentation-business-data-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/914e3fb7-d6c3-4bec-90b2-52b510e63c5e/template-card-presentation-business-data-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/05dceaff-f3bd-4557-ac30-e7eda5443475/template-card-presentation-business-data-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f82b2e6f-56de-486e-a05e-b13f3fa7617e/template-card-presentation-business-data-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6d1c69b9-89ac-4d53-aedc-53d71987d190/template-card-presentation-business-data-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/06cccce3-0c62-4883-a6e1-6f53642b8267/template-card-presentation-business-data-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be635b63-8ffc-43b6-b050-8327a57951bb/template-card-presentation-business-data-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/611b9af1-b28f-4bb1-9b59-0828081fee2d/template-card-presentation-business-data-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bc89eaa4-71f4-4ea1-ac89-2b2fb8ba0d75/template-card-presentation-business-data-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "crayon-learning-deck": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/573d3324-9c37-4766-85da-a1028b067558/template-card-presentation-crayon-learning-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5db0e73c-4312-4bcf-8b60-9094d2aafeac/template-card-presentation-crayon-learning-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7485a80b-eea3-46a4-a2be-507990a38b5f/template-card-presentation-crayon-learning-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7d6e15cb-91d9-4d72-8754-baa6ddb8085a/template-card-presentation-crayon-learning-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/94734712-0cc3-4b4c-9003-84af1a2514af/template-card-presentation-crayon-learning-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/007f3750-d7d9-4ac2-aa1c-62e384f320c3/template-card-presentation-crayon-learning-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/56596bbb-dd78-4005-9f59-d95d8ae8f740/template-card-presentation-crayon-learning-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d033dbf6-7795-4657-ba57-036d54613ba6/template-card-presentation-crayon-learning-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f0f6c062-7004-4827-8278-8bcf0ac60c7c/template-card-presentation-crayon-learning-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1ac6347b-85f4-4309-b900-dc7b1938c899/template-card-presentation-crayon-learning-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b86464ef-6475-4d6c-a35c-b6f6a192864a/template-card-presentation-crayon-learning-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c9747d98-4680-471e-8bda-d17a7e781f32/template-card-presentation-crayon-learning-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bac65be5-5285-4b74-bd74-ac7c3625e62b/template-card-presentation-crayon-learning-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/db4d73de-6ac9-4976-93f0-83003d2ca127/template-card-presentation-crayon-learning-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/329b2c3a-443e-4300-9325-7fd9bcfc78e1/template-card-presentation-crayon-learning-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8f780748-e093-46d8-9ed5-014b5638d4ee/template-card-presentation-crayon-learning-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4df5908d-e971-4a00-b109-e148d8f1b9c9/template-card-presentation-crayon-learning-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/78ab4a40-cace-424a-bf00-9856cbefc208/template-card-presentation-crayon-learning-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1e153a66-0c52-4986-a09f-33d0eafd4f3e/template-card-presentation-crayon-learning-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "creative-agency-presentation": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f40c998e-8046-487c-9bbd-6de2cfcdc7c8/template-card-presentation-creative-agency-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9ffc824b-516f-4187-b353-d3422b2d7436/template-card-presentation-creative-agency-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d69583c5-773a-4b29-8319-040858da2451/template-card-presentation-creative-agency-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/87fb4345-ec2d-42ee-940f-b1b447fdf660/template-card-presentation-creative-agency-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/caf31c90-310b-4565-afbc-56417821d89b/template-card-presentation-creative-agency-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8969312f-2959-4d7f-9d20-8a8e7086246d/template-card-presentation-creative-agency-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f5cc7730-ea22-4c98-840c-97f24eb3c605/template-card-presentation-creative-agency-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9186e9b5-54e6-4074-a218-13dab23a9407/template-card-presentation-creative-agency-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/756ca741-5821-4d80-96eb-19d4c0e32676/template-card-presentation-creative-agency-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9a7a0379-0c46-4bc0-b0f4-68d58955b615/template-card-presentation-creative-agency-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9b5f41e4-ac6c-4196-8758-1bc3b8b3fc60/template-card-presentation-creative-agency-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d178524d-c2ab-4f0d-89dd-39164f3928a5/template-card-presentation-creative-agency-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bd33d969-516d-4de3-9341-959a917a7fa7/template-card-presentation-creative-agency-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bbd6d782-d1d5-4fe5-9953-c96f8185e9be/template-card-presentation-creative-agency-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/94c2b0dd-f91a-45d7-a6e7-11d802ab23f9/template-card-presentation-creative-agency-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ce8fbeb8-7147-45d0-87c3-8369a6431d21/template-card-presentation-creative-agency-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7996a715-00f6-4e49-b7dd-1c8544917fa6/template-card-presentation-creative-agency-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c9f67da1-e05f-4db2-aee2-d4346bdff8ca/template-card-presentation-creative-agency-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9cfb560f-a59a-4284-8f7d-97cf101a77fb/template-card-presentation-creative-agency-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "data-report-presentation": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f8aa6480-16c2-4c20-8921-d1f9374a5583/template-card-presentation-data-report-presentation-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/77be1b72-eb93-40a3-8092-5f00d4773cf3/template-card-presentation-data-report-presentation-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6bea2f09-6981-48b9-96d2-32dc7c041c33/template-card-presentation-data-report-presentation-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/edb92e56-ec4f-4c68-9504-eab5a1c0d229/template-card-presentation-data-report-presentation-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5c2dbc64-ac8d-4227-b77a-54e438c945b2/template-card-presentation-data-report-presentation-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2103179a-6531-4d74-a783-f2a53d96db1c/template-card-presentation-data-report-presentation-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a6b0b5a2-ffe4-4cd4-ac0a-5248771f58da/template-card-presentation-data-report-presentation-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e3fde814-becf-4201-80de-c15ad28b9877/template-card-presentation-data-report-presentation-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/afc0eb94-05bb-45fe-8941-13345a43b530/template-card-presentation-data-report-presentation-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/627a0a57-4331-45c1-b85b-753748d32a49/template-card-presentation-data-report-presentation-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e444ffa3-fbbe-46be-8bce-b82eb05185f0/template-card-presentation-data-report-presentation-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c0657808-bbe4-421c-a539-73f29a88a9c9/template-card-presentation-data-report-presentation-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/777500cb-5c20-4ad4-80f1-b03fbabfafd9/template-card-presentation-data-report-presentation-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/75e4fd23-7e64-4a46-bf48-b56fe40d1e04/template-card-presentation-data-report-presentation-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/85e0270e-b8e0-4549-9361-9e809621fbc7/template-card-presentation-data-report-presentation-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9dddacc9-045a-4f59-9953-373f08fdbc33/template-card-presentation-data-report-presentation-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9b92dcbc-44b4-4b5d-ab9d-eea720a40f64/template-card-presentation-data-report-presentation-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/99b8df33-52d3-4f4e-8449-bb3c3cbdc1cc/template-card-presentation-data-report-presentation-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/17a13840-f70b-48c4-8ac7-9b541a4a034f/template-card-presentation-data-report-presentation-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "editorial-magazine-deck": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1551e99d-7620-49ec-bf1e-b578632a0358/template-card-presentation-editorial-magazine-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/903c73a7-8b68-4f2d-8fde-b913b016ecf4/template-card-presentation-editorial-magazine-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e549b9eb-9b2e-476a-88d1-ca7bb0d8667f/template-card-presentation-editorial-magazine-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a020ced3-6b94-408c-9936-3f9addd6a386/template-card-presentation-editorial-magazine-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/547d59dd-2c5d-4d67-b0dd-bc23d288ceb6/template-card-presentation-editorial-magazine-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/41c954ab-40d3-450b-8224-12d8072e0a5f/template-card-presentation-editorial-magazine-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c7bf667b-c28e-41c9-8b3d-a05ecf28fd70/template-card-presentation-editorial-magazine-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/32334be2-ab20-43f8-87b8-28a31777cacc/template-card-presentation-editorial-magazine-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/12b85e98-ea95-4bb7-81d3-406560a37cd5/template-card-presentation-editorial-magazine-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b81decad-3717-4619-8f34-4cb9eae5c56d/template-card-presentation-editorial-magazine-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/53d77993-878f-4a9f-a1fc-6739794660b6/template-card-presentation-editorial-magazine-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/23fe637e-8bff-40f0-a9ec-1aff2cb3063a/template-card-presentation-editorial-magazine-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7e9a2615-eafb-4fbe-91be-1c50192cb42c/template-card-presentation-editorial-magazine-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6f725279-a3b0-4d30-b20f-4782d6301ec3/template-card-presentation-editorial-magazine-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d8ce4a9-5ecb-4220-af1b-ab4d020dbd6c/template-card-presentation-editorial-magazine-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8d1782b7-7ffe-46f2-9959-1401f8925f0b/template-card-presentation-editorial-magazine-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0f906828-9f9a-4511-b402-8eeaf76150eb/template-card-presentation-editorial-magazine-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/edccdf1a-affc-426c-8477-b86947032d70/template-card-presentation-editorial-magazine-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3ed37006-a3a0-4347-adae-74ab5551972c/template-card-presentation-editorial-magazine-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "landing-consulting-deck": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f98d416d-0c26-4442-a72f-f960321c0bca/template-card-presentation-landing-consulting-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4273d3e4-08de-4a0a-b1d4-03f620310ac5/template-card-presentation-landing-consulting-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b2d0970e-cdbe-406f-ae44-a544dc2058c9/template-card-presentation-landing-consulting-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/41e46ea8-24f6-496e-834a-ea1f192024d7/template-card-presentation-landing-consulting-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c38f2446-4972-408b-8aa2-b870aac00c8c/template-card-presentation-landing-consulting-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/54caa4f0-4db9-49ed-b94f-29610ee39844/template-card-presentation-landing-consulting-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/915bfc6d-5fb8-48dd-8183-86794fc51680/template-card-presentation-landing-consulting-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9805a606-0587-471d-9429-d9326dcfd31d/template-card-presentation-landing-consulting-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/60db33cd-70cf-4d07-bd4a-5746b3fed10f/template-card-presentation-landing-consulting-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/99eafab2-1abc-4841-a3fb-f3625ee29546/template-card-presentation-landing-consulting-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e24adc64-24d6-4a8d-9b64-cfed4face42e/template-card-presentation-landing-consulting-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7f9ded5-98b3-4636-8c14-3aafb0ceb5b3/template-card-presentation-landing-consulting-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c2dc239f-52da-4468-9a55-82c7df87ebc5/template-card-presentation-landing-consulting-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7f94ec43-c3c4-4044-a5f9-84006d39fdbd/template-card-presentation-landing-consulting-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/25479deb-9d31-4170-8827-77136e3c1d99/template-card-presentation-landing-consulting-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d94f2dae-e7d0-4d4f-a513-b2e89b9c61a6/template-card-presentation-landing-consulting-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e5ffec05-27f0-49c6-942e-1000cc95f818/template-card-presentation-landing-consulting-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dfbaabfd-287f-4dfe-a48e-003e9da5db0f/template-card-presentation-landing-consulting-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/85a5bd66-c044-4898-8c33-e64b874acaf1/template-card-presentation-landing-consulting-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "lumina-creative-studio": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a92421d1-e4b5-4485-94b8-ba503d4dc8f5/template-card-presentation-lumina-creative-studio-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0ed47289-d3ce-4e60-b6dd-642090cc5130/template-card-presentation-lumina-creative-studio-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/78ce10cb-cb36-4c11-b8c7-e5ad59ef0249/template-card-presentation-lumina-creative-studio-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9958589a-2a37-46ee-bda8-fcd671b5be84/template-card-presentation-lumina-creative-studio-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3ef8c102-83e2-4690-800a-ecdca149d84a/template-card-presentation-lumina-creative-studio-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f865d013-fa34-43ad-9552-0cbc3ffdfad2/template-card-presentation-lumina-creative-studio-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ca187a3a-e808-4eb3-9e34-e41856d52377/template-card-presentation-lumina-creative-studio-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/00c5d13f-9458-4d87-9ae6-637e896ebe62/template-card-presentation-lumina-creative-studio-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9de8dc58-dada-4807-bb42-9ddd2a67631d/template-card-presentation-lumina-creative-studio-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d6224e63-2243-4fae-946a-53ee478ee818/template-card-presentation-lumina-creative-studio-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/991d9715-1fda-40bc-81ca-e1a0b6d53b34/template-card-presentation-lumina-creative-studio-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d1b7289-aef4-404f-b00b-1471c29c6907/template-card-presentation-lumina-creative-studio-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a7bfe0e9-3871-41f3-9e13-eb0c5cd81893/template-card-presentation-lumina-creative-studio-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3dc4e053-5613-4212-af8b-5f3454188e9f/template-card-presentation-lumina-creative-studio-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/21a22d38-ae77-4ff0-b7cb-8eeddf03efc7/template-card-presentation-lumina-creative-studio-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c89fa05a-f56a-48bb-b022-947fc09604e0/template-card-presentation-lumina-creative-studio-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7546735-b333-4dc8-a5f0-469043794f1e/template-card-presentation-lumina-creative-studio-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2d4f6e59-80ed-492e-8763-6ce2bbf32796/template-card-presentation-lumina-creative-studio-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2e043033-bda0-44ed-acd6-2d5eacd54104/template-card-presentation-lumina-creative-studio-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "mosaic-geometric-pitch": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/75c14836-a2b8-4f8a-b191-485317971dd9/template-card-presentation-mosaic-geometric-pitch-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9f6d4b35-3bc5-45be-aca3-18f6ec21530f/template-card-presentation-mosaic-geometric-pitch-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/014a0d17-b78a-48e7-b5cf-62d221204996/template-card-presentation-mosaic-geometric-pitch-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/14a7405a-25fe-4fe6-a05e-37e00fe78b2c/template-card-presentation-mosaic-geometric-pitch-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/20a6c016-082d-40c1-af47-a1a61c2f9e24/template-card-presentation-mosaic-geometric-pitch-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/125f9f28-64ec-4ec7-861b-7f508de7e1cf/template-card-presentation-mosaic-geometric-pitch-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8c545c12-fa00-4928-9d10-03cb3aaa99c2/template-card-presentation-mosaic-geometric-pitch-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a7f73d59-ea59-4b2f-a5b9-0482ddeed21e/template-card-presentation-mosaic-geometric-pitch-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/564b4bf7-ea19-4dd0-b320-2696db573aa9/template-card-presentation-mosaic-geometric-pitch-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/47350842-757c-4c4c-bf0f-ca8b14a3248a/template-card-presentation-mosaic-geometric-pitch-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/736c1ca8-0cd7-4832-87af-26ab7368252c/template-card-presentation-mosaic-geometric-pitch-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b2a98f28-8e60-4125-be6d-55b57fb69761/template-card-presentation-mosaic-geometric-pitch-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0d8eb614-f292-4992-b54e-917b35107446/template-card-presentation-mosaic-geometric-pitch-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e17df1f3-5530-4049-88d0-7c1287c0919f/template-card-presentation-mosaic-geometric-pitch-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4303dc0c-a8d6-45dc-80c0-18cbd993646f/template-card-presentation-mosaic-geometric-pitch-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/41557a1c-924f-4004-82e2-96689a341470/template-card-presentation-mosaic-geometric-pitch-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/91c4c7ec-bc83-4279-8d17-7bc918c83cc3/template-card-presentation-mosaic-geometric-pitch-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f3a8270e-5b43-4dac-b1af-4594b8093a7c/template-card-presentation-mosaic-geometric-pitch-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d889c78b-afae-494c-b912-8fd4fc79407d/template-card-presentation-mosaic-geometric-pitch-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "playful-pop-deck": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/824ca947-243b-468d-b2f2-cca11ac2fc21/template-card-presentation-playful-pop-deck-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7fd0063f-1782-41e7-beb6-8348b49b2854/template-card-presentation-playful-pop-deck-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9de5f4ed-f828-43ba-9817-059006bfae14/template-card-presentation-playful-pop-deck-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/35cd8145-7eb0-48f7-a125-031a9fb306d1/template-card-presentation-playful-pop-deck-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8b43ed5f-49c6-4b02-a363-04df4f63fffb/template-card-presentation-playful-pop-deck-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3cee34f8-ea65-4d88-8640-63e642d07115/template-card-presentation-playful-pop-deck-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ff194e5b-df8c-49ae-9b85-f17b9015b73f/template-card-presentation-playful-pop-deck-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/982e5b49-3ed8-474e-8c36-448bcd4a6e80/template-card-presentation-playful-pop-deck-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b27357bd-7424-41c6-bdf9-6b45af2f8976/template-card-presentation-playful-pop-deck-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/60ae9b9e-a4b6-4c7f-8890-98f838386af2/template-card-presentation-playful-pop-deck-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/38a1e94b-de28-4ec7-ad53-22d0f8fccfb6/template-card-presentation-playful-pop-deck-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b0d43553-5c35-44fa-b34b-c3ea8617a09a/template-card-presentation-playful-pop-deck-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e0f8f22-3078-4aec-bb6d-f759adc31524/template-card-presentation-playful-pop-deck-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/51d0681e-cbf3-4dcd-9072-359c8770c92b/template-card-presentation-playful-pop-deck-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/14ba252c-5e1a-4f2f-abcb-d62849b96ffd/template-card-presentation-playful-pop-deck-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7e8c4886-9433-4336-92e6-8a518f3135dd/template-card-presentation-playful-pop-deck-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9fcb63ea-85cd-4347-8ad9-488d9a9db0d7/template-card-presentation-playful-pop-deck-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/18fa6a6b-faee-4f8f-bdf0-733d0580bf6e/template-card-presentation-playful-pop-deck-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c7eb7646-65ae-463b-903e-4766f0721d70/template-card-presentation-playful-pop-deck-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "bloom-pitch": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/35347eab-989d-46da-8cd4-6846e9e18ae9/template-card-presentation-bloom-pitch-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/230f3210-598c-40da-8fad-7d9542b81a4c/template-card-presentation-bloom-pitch-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/14a9175b-eef4-4e7d-bb60-460320f9218a/template-card-presentation-bloom-pitch-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/25c375ca-29a9-46a2-83f4-9c6fe1bbbd4f/template-card-presentation-bloom-pitch-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/301f42f0-6951-4a4d-ae7d-492698cc9258/template-card-presentation-bloom-pitch-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/33f0825f-7ee7-440b-963b-fa0d530d33fc/template-card-presentation-bloom-pitch-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/af105437-5b40-4aa4-a89c-d82af48c0f7e/template-card-presentation-bloom-pitch-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/31ca5d00-5892-4066-b86b-4ab0cb9a152f/template-card-presentation-bloom-pitch-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/905769f2-adc4-49d0-b4a5-d53a13b4dd2a/template-card-presentation-bloom-pitch-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a3324ce-31ee-4e27-9185-18af861e8a64/template-card-presentation-bloom-pitch-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/14ece89e-3cac-428a-afb8-a693a7eb6edf/template-card-presentation-bloom-pitch-berry-pop-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/54187934-28bb-45f9-99b2-85a87b393b68/template-card-presentation-bloom-pitch-mauve-dusk-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bcbfde4e-8e65-4ac1-acf3-ee3f3af1c0bf/template-card-presentation-bloom-pitch-citrus-fresh-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cc225486-a2bd-4914-8bff-490178ac69ad/template-card-presentation-bloom-pitch-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a37df412-a08f-4a4f-9aa6-95fad92954e3/template-card-presentation-bloom-pitch-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4276aab6-90fe-4ea8-8672-be653e59e062/template-card-presentation-bloom-pitch-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/207bbb3b-70a3-41ad-9680-4f80dd6c6d34/template-card-presentation-bloom-pitch-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c07c402d-9dfc-4ccc-8eea-383fab53775c/template-card-presentation-bloom-pitch-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/99ca85e7-744d-4082-9cab-c0d274b1337d/template-card-presentation-bloom-pitch-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "blueprint-academy": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7d2e08a0-439f-46fe-a441-e39747de1212/template-card-presentation-blueprint-academy-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ba862728-b489-4bb4-8f6b-2afb5be91001/template-card-presentation-blueprint-academy-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/efc7d153-29e9-4180-bff0-1c6fe42bf5e5/template-card-presentation-blueprint-academy-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fac3c5c7-e87f-4482-9214-afbc37ee6135/template-card-presentation-blueprint-academy-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/beeee408-82cf-4965-bafe-2db5fb8602bd/template-card-presentation-blueprint-academy-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3557bad1-2e19-4284-a263-eece873a07f8/template-card-presentation-blueprint-academy-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/96d87e06-aaaa-4b46-8547-1876f8f1c8a3/template-card-presentation-blueprint-academy-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b6f8be0a-2ebc-4060-a6cb-f68a7640a514/template-card-presentation-blueprint-academy-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/599907b0-e101-4f73-93e6-14ed149d561a/template-card-presentation-blueprint-academy-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/87e2f57f-584c-46e4-b51c-a5549fd597c7/template-card-presentation-blueprint-academy-terracotta-clay-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e2cd5cf4-ab78-4b96-8013-aea034087622/template-card-presentation-blueprint-academy-citrus-fresh-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9814e9c7-1b58-40a5-a341-e6dbc8a8be9f/template-card-presentation-blueprint-academy-berry-pop-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/93bb8ccf-477e-4859-9a80-4117664d2bf4/template-card-presentation-blueprint-academy-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/69e3e91b-eaa4-417c-9ad4-10c19e78a72c/template-card-presentation-blueprint-academy-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a2b24f7b-ef4d-489d-a35e-42440a60417b/template-card-presentation-blueprint-academy-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/27b26028-107d-4574-975f-876a97580e15/template-card-presentation-blueprint-academy-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a54294df-1162-47c8-9734-4e63fe3e2de8/template-card-presentation-blueprint-academy-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/11516e2b-644e-45be-b302-22482daa4578/template-card-presentation-blueprint-academy-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/277df515-a377-4689-8821-69cef46faa34/template-card-presentation-blueprint-academy-gold-luxe-iframe-viewport-480x270.jpg",
  },
  meridian: {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/de20bbf9-8e3a-4559-b973-8e5e8257a3ee/template-card-presentation-meridian-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b567ed2a-93ce-491e-a57b-3695030d15de/template-card-presentation-meridian-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0cda265e-dc6f-4155-a574-03738317ae25/template-card-presentation-meridian-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/77928d19-c357-4879-a4c4-4dcf73fa80fd/template-card-presentation-meridian-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2294bc61-1f38-42f0-82d4-3161e63a6a81/template-card-presentation-meridian-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/139debec-2762-4f12-8b51-e6c81f6bed91/template-card-presentation-meridian-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fd11cdd5-c52f-4944-a735-ac54a60788e5/template-card-presentation-meridian-forest-editorial-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9f44f1a6-8e86-48fd-9322-5e7f60cc2f9a/template-card-presentation-meridian-slate-corporate-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/766756ad-9abb-42a9-acd2-8b8d983bc001/template-card-presentation-meridian-coral-studio-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/093a5d56-c399-43a8-97eb-caa988f76a11/template-card-presentation-meridian-terracotta-clay-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/49f1dccc-8b0e-488c-813e-69db266bb7cb/template-card-presentation-meridian-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0fcac9c7-b1e4-472f-9595-5b1969f69e8f/template-card-presentation-meridian-mauve-dusk-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9896d112-e859-494e-9750-d0126af2873d/template-card-presentation-meridian-berry-pop-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/acbbf029-1f2a-420f-b9fc-5c3e9eadc9a5/template-card-presentation-meridian-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3bd1b7ec-6a88-4b4b-9622-4c844255b971/template-card-presentation-meridian-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/23eb2ed6-fc1f-4070-8b0d-693376592de6/template-card-presentation-meridian-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8c38bdf2-674d-4d1c-8d58-4cb69607dfcb/template-card-presentation-meridian-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5749c58a-6c4b-4b32-903f-7be7ae4a89c2/template-card-presentation-meridian-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/023b2be2-a37e-4c1c-8d88-19cea31a0cbc/template-card-presentation-meridian-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "neo-brutalism": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e5a46773-05fd-4924-91f2-b8c902d84958/template-card-presentation-neo-brutalism-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d9c04806-8fbf-41c1-a669-e793522204d8/template-card-presentation-neo-brutalism-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/97ab3f21-3105-4fb9-b0e0-264d9865eef2/template-card-presentation-neo-brutalism-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/58accc81-eacc-4f8f-b02a-35b5d2acb742/template-card-presentation-neo-brutalism-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c73c3b1a-0e68-4740-af75-614118574683/template-card-presentation-neo-brutalism-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e3ddc73-36ad-4640-97c6-6420e3df5860/template-card-presentation-neo-brutalism-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/611711cc-b79f-4d02-a8e6-1ef2803797ff/template-card-presentation-neo-brutalism-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1ce685e3-8f30-4f73-870a-5c33eb50c934/template-card-presentation-neo-brutalism-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6ed0fe45-5cb1-4b5a-81a2-2cef5df8c765/template-card-presentation-neo-brutalism-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/079cb4aa-bec0-43ff-875b-4ffffa467901/template-card-presentation-neo-brutalism-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/96eb10dc-0658-43e0-88a9-4892d07d9f26/template-card-presentation-neo-brutalism-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cd3e83ce-91f3-4149-b9ad-422d00579433/template-card-presentation-neo-brutalism-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e76f1c4f-5ef7-474a-951c-0b7a4ef2898d/template-card-presentation-neo-brutalism-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2e682f70-2dab-41cb-b8d5-cbcc663bcf5b/template-card-presentation-neo-brutalism-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b8928393-4a58-4f9e-bc6b-3096c6fe51b4/template-card-presentation-neo-brutalism-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/379b03c0-17da-4aee-b790-1b516c9436ed/template-card-presentation-neo-brutalism-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3e5b2200-2a4d-4dbf-9c7a-ed69ba9dbc3b/template-card-presentation-neo-brutalism-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a2141a4-f0fb-4610-8035-f17cd7562f5e/template-card-presentation-neo-brutalism-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7f029831-8e6d-49ce-9bb4-3879d78a2bdc/template-card-presentation-neo-brutalism-gold-luxe-iframe-viewport-480x270.jpg",
  },
  nocturne: {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/47060ac2-2255-491b-822e-17e4879e8bb3/template-card-presentation-nocturne-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/86e393ee-3e0c-4a96-b15c-af1a6bf6421a/template-card-presentation-nocturne-carnival-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6c55154a-a225-4239-8c4e-c3e2f8963597/template-card-presentation-nocturne-warm-sand-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2c1d697a-5a5b-4745-8786-d4a200907259/template-card-presentation-nocturne-pop-art-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0ad83df4-0749-4516-a917-fe8a0a246989/template-card-presentation-nocturne-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb54e933-d3c0-48ec-83ce-4878acc674ea/template-card-presentation-nocturne-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c5188fd6-2cf8-4967-a527-a73455608ef6/template-card-presentation-nocturne-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/32dea48f-97b4-44fc-a32c-dbd30335e67d/template-card-presentation-nocturne-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d60f2752-79e9-46d0-9f98-39f109529a2b/template-card-presentation-nocturne-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/193a67b0-1084-4b4d-a68f-ebd83cff3595/template-card-presentation-nocturne-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bab7e049-8f49-4cbf-9084-77576c755218/template-card-presentation-nocturne-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b7c2717f-cdf3-46af-8ffc-86a54d3cafd7/template-card-presentation-nocturne-citrus-fresh-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/696367c1-aee5-4c34-bc24-bdba10917111/template-card-presentation-nocturne-mono-ink-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2e5415a3-27e7-4320-97db-bc5d9d684fc8/template-card-presentation-nocturne-mauve-dusk-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/28abedd2-b9e0-447f-a445-f0daa2235fae/template-card-presentation-nocturne-mint-tech-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b84c2859-8c0e-4e9b-b997-d9ff24162e01/template-card-presentation-nocturne-sunset-maroon-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b994d5c8-9601-4108-a80b-ed4cb88b3c18/template-card-presentation-nocturne-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9192f3e7-4ae4-4bf7-ac54-03d64834ce95/template-card-presentation-nocturne-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ec854c97-62c3-4bdd-b820-cdf62fafa5ef/template-card-presentation-nocturne-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "pixel-glitch": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/481b2398-8cbe-436b-a54d-6b277cb5c444/template-card-presentation-pixel-glitch-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2480dd7a-16ca-41e7-9308-731a0a8ed3bf/template-card-presentation-pixel-glitch-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/522d8149-0bba-4cb3-87df-234d8e7c8119/template-card-presentation-pixel-glitch-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fd49cd12-5fa9-41af-ac99-0a6a7553b89f/template-card-presentation-pixel-glitch-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ee6cc1a9-a8a7-4a66-9876-2d227c5a5a22/template-card-presentation-pixel-glitch-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/51b7c1f4-6d8c-46d7-ab49-93562b316198/template-card-presentation-pixel-glitch-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/80d95fa9-436b-42ea-b8e0-910d498d55e6/template-card-presentation-pixel-glitch-forest-editorial-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d18066ad-5876-46a4-9e2b-beabc6a38c87/template-card-presentation-pixel-glitch-slate-corporate-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/55e56b20-bef1-4d48-a84e-b1cafe758639/template-card-presentation-pixel-glitch-coral-studio-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/30a04cf3-a8c1-40ee-810c-20f743888c55/template-card-presentation-pixel-glitch-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7337562e-a8ba-4fbb-8eb7-84d23d57ca8e/template-card-presentation-pixel-glitch-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/12b12048-c8e3-4db3-bb41-3a1cd52f36b4/template-card-presentation-pixel-glitch-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/89a13e2b-b065-4b37-bd7a-275fe81b0063/template-card-presentation-pixel-glitch-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/70351076-1fbd-4767-b21d-ee2948ce1655/template-card-presentation-pixel-glitch-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ade9a11c-3b04-4a50-95e3-c30850eca22f/template-card-presentation-pixel-glitch-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c85b5845-b940-477c-b612-7f3a6c8ee25f/template-card-presentation-pixel-glitch-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2b38c57a-09d3-4edf-84f1-4280b35e2c2b/template-card-presentation-pixel-glitch-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/75243e50-5478-4b14-8d4b-9162ab26b63c/template-card-presentation-pixel-glitch-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2e62a49a-5dda-4e37-b785-97627cda9db4/template-card-presentation-pixel-glitch-gold-luxe-iframe-viewport-480x270.jpg",
  },
  prospectus: {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ee78696e-9a29-4988-b414-119e5bef18cf/template-card-presentation-prospectus-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c7621b28-8739-48e5-9d09-ef31bbad67c4/template-card-presentation-prospectus-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/911ce6d0-c609-4104-80ad-ff804f6432c8/template-card-presentation-prospectus-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/681e8f71-ab41-433a-8fb5-2bc2c6524d68/template-card-presentation-prospectus-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d281372-94d7-494b-96a0-69d4d693fae1/template-card-presentation-prospectus-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/609ca9f6-6807-42f8-af02-64ec9abc699e/template-card-presentation-prospectus-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6f753c56-9598-4605-afde-b526761176c9/template-card-presentation-prospectus-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d2239e3-ce16-4072-83cd-9f64ecf01e29/template-card-presentation-prospectus-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/35b01a49-0f92-482d-b930-edde0cfdeea1/template-card-presentation-prospectus-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7851aeb9-6adf-413e-97ce-d4159dcfaa75/template-card-presentation-prospectus-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a3b54886-3891-4b92-b54d-ceeec40b9816/template-card-presentation-prospectus-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d9b28cff-3f80-4ade-81b5-1fb198f9a268/template-card-presentation-prospectus-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c4d91151-4df8-418e-8ed4-0ca7e3f90028/template-card-presentation-prospectus-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e4d0c1fb-042f-4a67-93dd-318dd219e1d8/template-card-presentation-prospectus-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5915d9b5-c2d8-4fe2-996b-486fd21cad27/template-card-presentation-prospectus-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a8b70c7d-c3f1-435f-9df9-7cc48a65b015/template-card-presentation-prospectus-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7a37e9f5-42de-43aa-8273-df89a7821464/template-card-presentation-prospectus-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/93c4d241-247d-45cc-ad8a-6dd8d66ee18b/template-card-presentation-prospectus-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/aeda0b75-44aa-4baf-bf45-c279aba63e81/template-card-presentation-prospectus-gold-luxe-iframe-viewport-480x270.jpg",
  },
  schoolhouse: {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fd1bebe9-bc2b-4773-a437-969e5d820b43/template-card-presentation-schoolhouse-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/081c0721-fccd-4281-aae8-a690db56ce39/template-card-presentation-schoolhouse-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1dabfea2-d93a-4cac-b18e-71c75385a768/template-card-presentation-schoolhouse-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/43b0eb05-5efa-4e98-a342-776aec5ccf1e/template-card-presentation-schoolhouse-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d65c960e-2dce-4f6a-b8c8-c5b270df41c3/template-card-presentation-schoolhouse-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/eecf7cf5-bd26-435b-bbc9-b9e9fddf8f86/template-card-presentation-schoolhouse-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/821c23f9-46c4-4e6f-888c-80ff15250b7c/template-card-presentation-schoolhouse-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4fc14c67-2280-4430-803b-a0046cfc09cf/template-card-presentation-schoolhouse-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0d3047af-44ce-4f4c-92c9-463e9ba21b2f/template-card-presentation-schoolhouse-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/711a7c8e-dac2-459d-b751-0a016ee3763d/template-card-presentation-schoolhouse-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bedee58f-4988-441a-b207-f894f03add4d/template-card-presentation-schoolhouse-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e9301948-d620-4dee-a76b-ab2ebf228148/template-card-presentation-schoolhouse-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f91d627a-644e-4872-90b3-6abd4b7fd209/template-card-presentation-schoolhouse-mauve-dusk-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c0e50c3b-9e48-47d5-978f-5115d0094303/template-card-presentation-schoolhouse-sunset-maroon-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/50648f87-8f18-4646-ae36-2fd212e19158/template-card-presentation-schoolhouse-mono-ink-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2780816a-434d-4203-b80a-67ebd79aa025/template-card-presentation-schoolhouse-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d20120c-2920-4148-ad42-bdcfb4b799f1/template-card-presentation-schoolhouse-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a43eebaa-911f-4c1a-823e-af4a6f797c91/template-card-presentation-schoolhouse-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be9c0717-742d-4d41-a4e8-ead241124b6d/template-card-presentation-schoolhouse-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "sticker-scrapbook": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ca5c4a1c-eb36-4462-a6e8-e64453798c5b/template-card-presentation-sticker-scrapbook-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/336e9804-41cf-41d5-a2e3-ae127205f700/template-card-presentation-sticker-scrapbook-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b43c91a7-dbc3-442f-9319-6d3d8c9dbddf/template-card-presentation-sticker-scrapbook-pop-art-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9cf18292-0ae1-4c00-bf36-552e44468ee2/template-card-presentation-sticker-scrapbook-nordic-frost-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0eebc10c-16d4-4722-8483-157fbf4dc864/template-card-presentation-sticker-scrapbook-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a020f7d4-0cab-466e-a344-5fbe832cf476/template-card-presentation-sticker-scrapbook-bauhaus-primary-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/210ea3dd-4298-468f-bef2-896f8dc20948/template-card-presentation-sticker-scrapbook-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ab4ac022-0454-4c23-bcaa-a4258a2646aa/template-card-presentation-sticker-scrapbook-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9fed234f-eb63-4296-915f-1de54528a1ff/template-card-presentation-sticker-scrapbook-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f3197cd0-0b7b-4fa6-aca1-7f4dc363084c/template-card-presentation-sticker-scrapbook-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/092bd74d-0b60-49b8-88d9-7a73241bf6cc/template-card-presentation-sticker-scrapbook-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/07656a02-12dc-49fc-a328-25a7d11ed13e/template-card-presentation-sticker-scrapbook-citrus-fresh-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2d8b7b45-129b-4ace-a528-b4381f42175b/template-card-presentation-sticker-scrapbook-mono-ink-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/44e915f1-5fbc-4129-bc03-444be1beca68/template-card-presentation-sticker-scrapbook-mauve-dusk-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/72e91eab-542d-45f6-9cef-5989ab861fcc/template-card-presentation-sticker-scrapbook-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/75efce92-326a-44cf-b027-d5d265b087b1/template-card-presentation-sticker-scrapbook-mint-tech-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4bd6781b-bd7f-459f-8e58-d76f33e96854/template-card-presentation-sticker-scrapbook-ocean-deep-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2cae903b-0044-4255-9441-9b4e7d28c2eb/template-card-presentation-sticker-scrapbook-midnight-mono-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a21b891a-76f7-4195-83dc-d4fbc363ae82/template-card-presentation-sticker-scrapbook-gold-luxe-iframe-viewport-480x270.jpg",
  },
  strata: {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/72a43438-0e3d-40af-95b3-5134e5dc3b4d/template-card-presentation-strata-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/67855d35-f892-49ce-a53f-a73e65c2ada5/template-card-presentation-strata-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/58623674-39cf-4535-817b-6bf57e0c0a01/template-card-presentation-strata-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7d0ac85f-5d2d-4cb7-9390-38b8aea3da41/template-card-presentation-strata-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/18fad345-bc9e-4c43-974a-1103ee1f065e/template-card-presentation-strata-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8a74e1a5-869d-49de-8871-479322a0d539/template-card-presentation-strata-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ee51749d-c417-4ca1-b556-28176166d86d/template-card-presentation-strata-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c6577050-4bdb-447d-bb0b-ce19a56fdb25/template-card-presentation-strata-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/11168bfc-57b8-49ce-8d9a-a38ecbe899d9/template-card-presentation-strata-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/861353d6-7c4c-45df-aec0-9ef4103694cd/template-card-presentation-strata-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4f82d9b5-65e1-4af5-8abe-cb1bfc3394d3/template-card-presentation-strata-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/661a2367-2d7c-4f46-8235-2a940c22234d/template-card-presentation-strata-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f8e12ed4-25f0-4c99-85a4-931aa56096c3/template-card-presentation-strata-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1726673d-8581-42d0-a088-16c88ab396be/template-card-presentation-strata-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/80f52012-f15e-4c0e-85c7-a66255fad20f/template-card-presentation-strata-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ae36aa15-edbd-4c21-8c52-e67e0006ab37/template-card-presentation-strata-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7e96a8c7-e056-4eb6-a3d4-3b210fc0526c/template-card-presentation-strata-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/76dbc0dd-0eef-47f2-96ae-d1581cb056bf/template-card-presentation-strata-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d200d78-790c-4f75-863a-b164433363dd/template-card-presentation-strata-gold-luxe-iframe-viewport-480x270.jpg",
  },
  "taped-consulting": {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cc1fa0b4-4a80-4080-aa29-2e5e88fcedc1/template-card-presentation-taped-consulting-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/29a9f491-e529-4e25-a0fe-8bbad6292b5f/template-card-presentation-taped-consulting-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0962b3db-ebff-409d-84d9-280f9d776c67/template-card-presentation-taped-consulting-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a6e000f4-9495-4004-a4be-431fe3c2b1b7/template-card-presentation-taped-consulting-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/08e71cc7-b76d-465c-af0d-663f05f4e5d1/template-card-presentation-taped-consulting-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/eb1e00ad-835c-4dff-88c5-fca88e4b88c3/template-card-presentation-taped-consulting-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ffee95a5-e561-419c-ac27-fdef4495d732/template-card-presentation-taped-consulting-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7ccb111a-d790-4545-bc77-e19a0b0042bb/template-card-presentation-taped-consulting-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0ca89f7a-bd0f-4085-b7dc-d70e0558fcb6/template-card-presentation-taped-consulting-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/37298c0c-3ecf-4d39-93b7-f01c0e156b4e/template-card-presentation-taped-consulting-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d3b185af-6b45-437a-af60-ab671ceab6eb/template-card-presentation-taped-consulting-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f586c683-ae54-4ff3-9ed8-24e989f7fe8b/template-card-presentation-taped-consulting-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7aa6b6b7-2039-40d6-8d59-edbf4442ecc6/template-card-presentation-taped-consulting-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2984e4fe-83c7-4a4a-9dd0-a49a9dcb2a5e/template-card-presentation-taped-consulting-mono-ink-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/72b5c577-251d-48c1-a429-096328ac8598/template-card-presentation-taped-consulting-sunset-maroon-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b77bd363-c309-47f8-b226-074cbbbc233d/template-card-presentation-taped-consulting-mint-tech-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fdb68a30-f335-49ad-bedb-fa7d8c61117b/template-card-presentation-taped-consulting-midnight-mono-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d4d3a17f-3a9d-4de0-b6ea-dcba7b86b5d7/template-card-presentation-taped-consulting-ocean-deep-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0a2d990b-8368-4b46-8c3b-47ddb5dc9f04/template-card-presentation-taped-consulting-gold-luxe-iframe-viewport-480x270.jpg",
  },
  vantage: {
    prism:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/536ace67-54c4-4bf2-a53e-1ff0f0062ffd/template-card-presentation-vantage-prism-iframe-viewport-480x270.jpg",
    carnival:
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb021ec7-f6a0-4124-b096-d9ae2173e01d/template-card-presentation-vantage-carnival-iframe-viewport-480x270.jpg",
    "pop-art":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9df78d40-4ad9-4f07-ab09-b90dea758b19/template-card-presentation-vantage-pop-art-iframe-viewport-480x270.jpg",
    "warm-sand":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9a3372b6-4b7a-4bc7-85f3-172e16b8d370/template-card-presentation-vantage-warm-sand-iframe-viewport-480x270.jpg",
    "bauhaus-primary":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a67fd082-0300-48a2-8e06-76914aa59a34/template-card-presentation-vantage-bauhaus-primary-iframe-viewport-480x270.jpg",
    "nordic-frost":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b1da8e2b-e23a-41dc-8aca-c36a66676b44/template-card-presentation-vantage-nordic-frost-iframe-viewport-480x270.jpg",
    "forest-editorial":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/66af2f92-353b-4d27-a12a-765e1186655e/template-card-presentation-vantage-forest-editorial-iframe-viewport-480x270.jpg",
    "coral-studio":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/39c3bbd2-49e9-4254-847a-353aabd6b1ed/template-card-presentation-vantage-coral-studio-iframe-viewport-480x270.jpg",
    "slate-corporate":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/71e1059c-b040-4a6d-a7eb-0ae10b57e41e/template-card-presentation-vantage-slate-corporate-iframe-viewport-480x270.jpg",
    "terracotta-clay":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/70232c94-4890-4dea-9e86-3d480b62f83a/template-card-presentation-vantage-terracotta-clay-iframe-viewport-480x270.jpg",
    "berry-pop":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2471901a-80ed-4006-81cd-432b6a1fe4f6/template-card-presentation-vantage-berry-pop-iframe-viewport-480x270.jpg",
    "citrus-fresh":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2067e8c2-1d63-4764-8327-8b31a9313ba7/template-card-presentation-vantage-citrus-fresh-iframe-viewport-480x270.jpg",
    "mauve-dusk":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/87ebbe2c-2877-4133-8a5d-385b81a3068e/template-card-presentation-vantage-mauve-dusk-iframe-viewport-480x270.jpg",
    "mono-ink":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1466a7a7-fb13-44db-8687-9c99d282dd8e/template-card-presentation-vantage-mono-ink-iframe-viewport-480x270.jpg",
    "mint-tech":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f46edc1b-d119-4098-9b72-739227219258/template-card-presentation-vantage-mint-tech-iframe-viewport-480x270.jpg",
    "sunset-maroon":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fc40f686-cf2a-41b4-b5d9-02568b6c25a4/template-card-presentation-vantage-sunset-maroon-iframe-viewport-480x270.jpg",
    "midnight-mono":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d1ee4993-9f2d-417e-a517-1db4fe580e21/template-card-presentation-vantage-midnight-mono-iframe-viewport-480x270.jpg",
    "gold-luxe":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/583606ad-eaed-472e-8495-03c57b778db4/template-card-presentation-vantage-gold-luxe-iframe-viewport-480x270.jpg",
    "ocean-deep":
      "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fbcc6ed8-6881-44d9-aedc-9478b6cd3eb8/template-card-presentation-vantage-ocean-deep-iframe-viewport-480x270.jpg",
  },
} as const satisfies Readonly<
  Record<
    string,
    Readonly<
      Record<
        (typeof PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES)[number],
        string
      >
    >
  >
>;

const BOTANE_ORGANIC_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/64d1a85a-9347-48fb-860b-073180385b66/botane-organic-deck.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a43f103f-e4b3-40b0-a326-c37a2240e6b5/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/576f05a7-2d2c-4963-876b-6eda1fe8f93e/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/12a44151-de3a-465d-9631-df029387a922/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cc6d6522-6f49-4dd0-a122-903a2251f014/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2195f286-6e9e-4171-9240-90c03924b898/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/889dd3cf-913c-4f79-99fc-c57f4346cef5/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b1116116-80a5-4d4c-bd74-43a66bed970b/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d0f5b82-cb4d-4b5a-8c7b-de8941758cf8/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7a5835b1-9545-46e1-ac8b-4d33de6fca14/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/72162ad3-7cda-4eb8-9bc3-9a986c06e120/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/68e2256e-3872-45b5-bcc6-a7cedf6d3e8f/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2a7fd3d2-562f-4b49-8854-562b13fa7fbc/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ba0a9ade-6eba-4a63-8772-976b30ab17cf/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7da6a51c-4a78-4e50-9cbc-899879e72875/slide-15.png",
] as const satisfies readonly [string, ...string[]];

export const PRESENTATION_TEMPLATE_ITEMS: readonly PresentationTemplateItem[] =
  [
    {
      slug: "starship-v3-investor-update",
      title: "Starship V3 Investor Update",
      prompt:
        "/gen presentation with design system `spacex` and template `html-ppt-pitch-deck`, create a Starship V3 investor update deck. Cadence numbers, payload mass to LEO, Raptor 3 cost curve, lunar Starlink V3 architecture, and 18-month roadmap. Make it feel aerospace, technical, austere, bold.",
      embedUrl: "https://starship-v3-investor-update-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ca9ba36d-af12-4e01-8744-37b1d311c50c/01.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f10313c4-51b6-4485-bd25-278833b5fc12/0_starship-v3-investor-update_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/93ec0146-ae62-46e2-ad89-983c25005251/0_starship-v3-investor-update_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/379a1832-00b9-458a-855f-e8031394aa52/0_starship-v3-investor-update_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/568be440-da0a-427f-b6ca-abab80f3ac13/0_starship-v3-investor-update_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a2602b35-dce2-4930-aec1-2ac76860b96d/0_starship-v3-investor-update_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8c1a3f70-7e10-4cb6-b98d-e71d69b79b42/0_starship-v3-investor-update_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5f8ab6fe-fe66-4796-a522-914bc572cfaf/0_starship-v3-investor-update_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1abd5de1-32c2-4476-af0f-2fc42cf8a83c/0_starship-v3-investor-update_08.jpg",
      ],
      designSystemId: "design-system:spacex",
      templateId: "template:html-ppt-pitch-deck",
    },
    {
      slug: "vision-pro-studio-keynote",
      title: "Vision Pro Studio Keynote",
      prompt:
        "/gen presentation with design system `apple` and template `html-ppt-product-launch`, create a Vision Pro Studio Edition launch keynote. Hero reveal, R2 silicon specs, spatial workflows demo, pricing tiers, availability windows. Make it feel cinematic, minimal, premium.",
      embedUrl: "https://vision-pro-studio-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/69edbfb9-c17c-479a-a5b1-f40544bc4aad/02.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/411e5fb1-399f-4586-9aac-8f504b55f152/1_vision-pro-studio-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7ac284e9-d6fd-484c-92fe-2709deabc1dd/1_vision-pro-studio-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b10bd765-ae16-42f6-9d4f-6ac0f8669c25/1_vision-pro-studio-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e3ae88b4-f5f6-408c-a536-7c965669324b/1_vision-pro-studio-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5a8f6ab6-b717-47e5-b62b-00aa999ba367/1_vision-pro-studio-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/88a429e4-f19c-4934-90b3-1135c485e055/1_vision-pro-studio-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5fe8b624-b853-4a38-ac48-3f6fe60446a5/1_vision-pro-studio-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6d4b2dc1-4456-4ed9-bd8a-78f28573c66d/1_vision-pro-studio-keynote_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/636ba321-df9c-4186-833f-731542f094ba/1_vision-pro-studio-keynote_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/12d54164-2a29-403c-a9a9-cab64e938a3b/1_vision-pro-studio-keynote_10.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/135df8e2-85e3-430e-bc52-2b430303ebf5/1_vision-pro-studio-keynote_11.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/67434f6f-8dbd-4eff-b67d-9b8bab46f5df/1_vision-pro-studio-keynote_12.jpg",
      ],
      designSystemId: "design-system:apple",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "tesla-q3-2026-shareholder-talk",
      title: "Tesla Q3 2026 Shareholder Talk",
      prompt:
        "/gen presentation with design system `tesla` and template `html-ppt-presenter-mode-reveal`, create a Q3 2026 vehicle delivery and FSD v14 shareholder talk. Production ramp, energy storage attach, FSD miles-per-intervention, Cybercab pilot cities, gigafactory map. Make it feel kinetic, sleek, confident.",
      embedUrl:
        "https://tesla-q3-2026-shareholder-talk-715f6d07-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e00269f7-b179-4fd6-b62f-e67a96808677/03.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f8fdfefe-f1bf-4d01-8df0-1ee398ef320d/2_tesla-q3-2026-shareholder-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3ce1e2ac-4e88-4567-8ce4-b10e5a199ee2/2_tesla-q3-2026-shareholder-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1bd86a47-e07e-4752-bfb7-dfc8098bb66d/2_tesla-q3-2026-shareholder-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ded0a305-cf2f-4247-8e5d-15041bff072c/2_tesla-q3-2026-shareholder-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/863231e7-8c50-4506-a8b4-0a479b0c9506/2_tesla-q3-2026-shareholder-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/521ec1e4-a599-49a8-9bb5-6e89d68a0252/2_tesla-q3-2026-shareholder-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e2476458-7ec3-411e-aa87-19ead199bc1f/2_tesla-q3-2026-shareholder-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2150d804-faf4-4bcf-ba30-504837d718f2/2_tesla-q3-2026-shareholder-talk_08.jpg",
      ],
      designSystemId: "design-system:tesla",
      templateId: "template:html-ppt-presenter-mode-reveal",
    },
    {
      slug: "ferrari-sf90-xx-unveiling",
      title: "Ferrari SF90 Xx Unveiling",
      prompt:
        "/gen presentation with design system `ferrari` and template `html-ppt-zhangzara-bold-poster`, create an SF90 XX Stradale press unveiling. Powertrain reveal, aero numbers, track lap record, livery palette, owner-program tiers. Make it feel red-blooded, editorial, prestige.",
      embedUrl:
        "https://ferrari-sf90-xx-unveiling-715f6d07-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2bd7518a-7689-4145-8d69-896c8ed8a10b/04.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/035528a9-fa73-4d64-af11-51c4d8d76e14/3_ferrari-sf90-xx-unveiling_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb85f7a8-3038-466b-aced-c6797a64e5ef/3_ferrari-sf90-xx-unveiling_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6ba94485-fb91-474e-88bf-0a42eb419491/3_ferrari-sf90-xx-unveiling_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7b023249-beb2-4d52-9140-cdd14f085bbb/3_ferrari-sf90-xx-unveiling_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f53b992a-5e05-451a-a19f-37e5260028fc/3_ferrari-sf90-xx-unveiling_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c8cf8e84-c3d9-4b2b-9cba-6e3ae443ff4a/3_ferrari-sf90-xx-unveiling_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ec12892a-08e2-4849-bccc-e70970e5dca8/3_ferrari-sf90-xx-unveiling_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e3b505a3-0c42-4c05-a514-380552b64568/3_ferrari-sf90-xx-unveiling_08.jpg",
      ],
      designSystemId: "design-system:ferrari",
      templateId: "template:html-ppt-zhangzara-bold-poster",
    },
    {
      slug: "air-max-day-2026-campaign",
      title: "Air Max Day 2026 Campaign",
      prompt:
        "/gen presentation with design system `nike` and template `html-ppt-zhangzara-coral`, create an Air Max Day 2026 brand campaign deck. Story arc, athlete ambassadors, drop calendar, retail activations, social moments. Make it feel bold, kinetic, street.",
      embedUrl: "https://air-max-day-2026-campaign-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9b0ccacc-9e9a-4c9d-bd01-fab56b24f5a5/05.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/daeada6b-bacf-4e56-bce6-8f8442eafda2/4_air-max-day-2026-campaign_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/162df356-184f-45c3-af6f-644dfb926c65/4_air-max-day-2026-campaign_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3ad3eb5b-3233-424f-89c4-22f2f917e21d/4_air-max-day-2026-campaign_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d217a06f-d089-462c-94fd-cfa911ea2510/4_air-max-day-2026-campaign_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dbf04f59-b088-429c-bfa7-6e995d84b96a/4_air-max-day-2026-campaign_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a73405d0-41b6-474a-909b-fbab1fa9843e/4_air-max-day-2026-campaign_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5892cd9e-86bf-4814-bddf-0058d8b1860a/4_air-max-day-2026-campaign_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/daf726ec-29e6-42c2-bb51-50de4b98b0cf/4_air-max-day-2026-campaign_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bbaa91d7-6bc0-4129-9bf0-2b51b1813855/4_air-max-day-2026-campaign_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4cc12c30-7ec6-4163-972c-0a0b988f4513/4_air-max-day-2026-campaign_10.jpg",
      ],
      designSystemId: "design-system:nike",
      templateId: "template:html-ppt-zhangzara-coral",
    },
    {
      slug: "crypto-liquidity-flow-research",
      title: "Crypto Liquidity Flow Research",
      prompt:
        "/gen presentation with design system `binance` and template `html-ppt-graphify-dark-graph`, create a crypto liquidity flow research readout. Order book heatmap, market-maker graph, stablecoin corridors, MEV anomalies, settlement latency. Make it feel dark, quantitative, technical.",
      embedUrl: "https://crypto-liquidity-flow-research-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1d0b732-27f3-41be-833d-c822f4c23797/06.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/de259c12-a811-4ad1-8707-0af52b5c2e2d/5_crypto-liquidity-flow-research_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a8766da-d023-4dc2-8422-10fd8c2efb1f/5_crypto-liquidity-flow-research_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2b7d97eb-a1e6-4098-b2c1-2bbff2b5df99/5_crypto-liquidity-flow-research_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/33745cb9-6c8f-4292-822f-dc3b3b6d08c0/5_crypto-liquidity-flow-research_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7a9d2df2-69b5-4cba-9fd9-ff051a87e6d8/5_crypto-liquidity-flow-research_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d9d928f4-f6ad-4a6f-be60-52dd1f2491c9/5_crypto-liquidity-flow-research_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/db0af70b-3d97-4d11-816f-1e1eeb602025/5_crypto-liquidity-flow-research_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e223be47-498f-4e7e-aa0f-cbdc8de593f1/5_crypto-liquidity-flow-research_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a629b78-5007-4fe7-9618-13c1a72ec1fc/5_crypto-liquidity-flow-research_09.jpg",
      ],
      designSystemId: "design-system:binance",
      templateId: "template:html-ppt-graphify-dark-graph",
    },
    {
      slug: "bmw-neue-klasse-brand-book",
      title: "Bmw Neue Klasse Brand Book",
      prompt:
        "/gen presentation with design system `bmw` and template `html-ppt-zhangzara-broadside`, create a Neue Klasse design language brand book unveil. Silhouette sketches, Hofmeister kink evolution, interior philosophy, color palette, model rollout. Make it feel precise, modernist, refined.",
      embedUrl: "https://bmw-neue-klasse-brand-book-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/eafc6916-cf43-45ab-a274-3455738a5ef5/07.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bf8e9607-7184-44f9-94d3-10be56e74bd2/6_bmw-neue-klasse-brand-book_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be0738a0-1950-48c5-a6b0-c60275d6f24d/6_bmw-neue-klasse-brand-book_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a66789a9-aa63-401e-bd5d-41c804c6dca7/6_bmw-neue-klasse-brand-book_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/897a91b2-4c98-4737-b4a1-f572019fd4a8/6_bmw-neue-klasse-brand-book_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3957a012-bde7-435f-b27a-b1b5f81e7341/6_bmw-neue-klasse-brand-book_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/845617f9-f4fc-4085-9047-34d154a12b3d/6_bmw-neue-klasse-brand-book_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b8f9461e-b934-4cb1-8ee2-6277e8d67083/6_bmw-neue-klasse-brand-book_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d8c40449-b529-4376-9904-3f3b19d894dc/6_bmw-neue-klasse-brand-book_08.jpg",
      ],
      designSystemId: "design-system:bmw",
      templateId: "template:html-ppt-zhangzara-broadside",
    },
    {
      slug: "bmw-m5-cs-touring-keynote",
      title: "Bmw M5 CS Touring Keynote",
      prompt:
        "/gen presentation with design system `bmw-m` and template `html-ppt-product-launch`, create an M5 CS Touring launch keynote. Power numbers, Nurburgring time, chassis tech, livery options, customer track-day program. Make it feel motorsport, aggressive, premium.",
      embedUrl: "https://bmw-m5-cs-touring-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/da219e0c-35eb-4a3f-8d11-0ace6dcd32c4/08.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/22456bdb-27c5-46eb-806a-4c244b94b63d/7_bmw-m5-cs-touring-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d72dfa6-a646-414b-a9d4-e80a002bfcc4/7_bmw-m5-cs-touring-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c2206e8e-441b-4b42-8516-99f1ef016c0b/7_bmw-m5-cs-touring-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4a9e4189-0485-4d08-9e95-5e7129259daa/7_bmw-m5-cs-touring-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ce2afe58-79b5-44a5-b854-75c3ea4e509a/7_bmw-m5-cs-touring-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9c539e1d-542b-48e7-8944-9b4c292667f3/7_bmw-m5-cs-touring-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/54d72238-deaa-4bca-a4f6-8029a4fa9261/7_bmw-m5-cs-touring-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cf66522c-3bae-4cd3-ae45-d6c026f9de5d/7_bmw-m5-cs-touring-keynote_08.jpg",
      ],
      designSystemId: "design-system:bmw-m",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "bugatti-tourbillon-owners-briefing",
      title: "Bugatti Tourbillon Owners Briefing",
      prompt:
        "/gen presentation with design system `bugatti` and template `html-ppt-zhangzara-monochrome`, create a Tourbillon hyper-GT owners briefing. Powertrain, atelier customization, Molsheim delivery experience, road-touring routes, heritage references. Make it feel luxury, hand-built, French-refined.",
      embedUrl:
        "https://bugatti-tourbillon-owners-briefing-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ed07e5e0-76f0-4dc2-8376-8aac6fafa254/09.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/92ea1730-292c-4845-be61-ffcd5efecfab/8_bugatti-tourbillon-owners-briefing_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/39768d48-e402-41fd-8cc2-069d8e81913d/8_bugatti-tourbillon-owners-briefing_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/61eb0f8d-a22e-4a87-af5b-e4fc9706155e/8_bugatti-tourbillon-owners-briefing_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8a397b60-9f8a-40fb-ac28-9f5153e0035e/8_bugatti-tourbillon-owners-briefing_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/03910b54-8391-44b4-bbe8-eb8b0cb4b4a0/8_bugatti-tourbillon-owners-briefing_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/253fb1ed-d6a9-444c-aadc-56976bc70d76/8_bugatti-tourbillon-owners-briefing_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c5d6b984-ef6f-4197-b12f-1f99d9c27a1b/8_bugatti-tourbillon-owners-briefing_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/57dc4278-e8af-4069-ba0d-15d00ef8c147/8_bugatti-tourbillon-owners-briefing_08.jpg",
      ],
      designSystemId: "design-system:bugatti",
      templateId: "template:html-ppt-zhangzara-monochrome",
    },
    {
      slug: "lamborghini-revuelto-2027-lineup",
      title: "Lamborghini Revuelto 2027 Lineup",
      prompt:
        "/gen presentation with design system `lamborghini` and template `html-ppt-zhangzara-studio`, create a Revuelto color and trim 2027 lineup deck. Ad Personam palettes, carbon weave options, Y-shape design language, dealer rollout, owner events. Make it feel high-voltage, theatrical, exotic.",
      embedUrl:
        "https://lamborghini-revuelto-2027-lineup-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/9aa58691-6af0-41f9-a841-719a7134dfce/10.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/efdf89b5-a4f2-4bf7-a32f-3f783d751e4a/9_lamborghini-revuelto-2027-lineup_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dcb6a2a6-5692-45c1-8f59-2ab19d102665/9_lamborghini-revuelto-2027-lineup_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/07eba2e7-c340-4a9f-998f-92ce29c4960f/9_lamborghini-revuelto-2027-lineup_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/23363efe-b265-4d8d-bd6f-5ea4cd989baa/9_lamborghini-revuelto-2027-lineup_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4ff53716-7372-48a2-bb57-74c851f95b02/9_lamborghini-revuelto-2027-lineup_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1274cb81-ac81-47b3-a139-cbdb283bc1fe/9_lamborghini-revuelto-2027-lineup_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8a8ad63d-5ec8-4d43-8215-1cd31682f18d/9_lamborghini-revuelto-2027-lineup_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a15fb84d-71d6-43ad-ad3a-6b57500d144c/9_lamborghini-revuelto-2027-lineup_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2adec129-e85f-4b21-8948-763c54b58a0d/9_lamborghini-revuelto-2027-lineup_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c376fb76-cbc8-4ead-b1ba-48a6a1a056f4/9_lamborghini-revuelto-2027-lineup_10.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d4236d3-0717-48bd-8f44-c237a4e0a0a4/9_lamborghini-revuelto-2027-lineup_11.jpg",
      ],
      designSystemId: "design-system:lamborghini",
      templateId: "template:html-ppt-zhangzara-studio",
    },
    {
      slug: "renault-5-etech-retro-launch",
      title: "Renault 5 Etech Retro Launch",
      prompt:
        "/gen presentation with design system `renault` and template `html-ppt-zhangzara-cartesian`, create a Renault 5 E-Tech retro-launch deck. Heritage timeline, battery options, charging network, color palette, French market positioning. Make it feel warm, design-forward, French.",
      embedUrl: "https://renault-5-etech-retro-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/67056cf8-b935-4eab-bbf9-d63f906aace2/11.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/93909fcf-61eb-4a7f-9f1e-7c627952cd38/10_renault-5-etech-retro-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/03f9bdf6-0032-426f-95ae-466c21b742f9/10_renault-5-etech-retro-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9ba355f8-46db-4bd0-87b0-05cf2262424f/10_renault-5-etech-retro-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7d6b1579-b3dd-452c-8fab-4056295c8ee1/10_renault-5-etech-retro-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ed16fa89-f09d-4f96-8f75-6fb1a0452f49/10_renault-5-etech-retro-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/afa08c8d-121f-43ca-9134-91751dbec259/10_renault-5-etech-retro-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/645afc4e-c762-4f24-9888-5cd091908c80/10_renault-5-etech-retro-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bdd26df3-e4a8-42fa-b70a-d83ac3c34f41/10_renault-5-etech-retro-launch_08.jpg",
      ],
      designSystemId: "design-system:renault",
      templateId: "template:html-ppt-zhangzara-cartesian",
    },
    {
      slug: "claude-5-model-deep-dive",
      title: "Claude 5 Model Deep Dive",
      prompt:
        "/gen presentation with design system `claude` and template `html-ppt-obsidian-claude-gradient`, create a Claude 5 model card and product deep-dive. Eval suite, constitutional AI updates, context window, agent harness, customer wins. Make it feel thoughtful, deliberate, gradient-elegant.",
      embedUrl: "https://claude-5-model-deep-dive-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/51044e26-0fb2-48eb-952e-c46a06602df8/13.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ecd22a88-d1eb-4e14-af96-54d603347eae/11_claude-5-model-deep-dive_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f31e0258-c7ce-404d-b01a-643276fa52e5/11_claude-5-model-deep-dive_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bb7b42b2-8fdc-407d-8f9c-46fa5cd77e5d/11_claude-5-model-deep-dive_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5dfc8b20-86f8-4b4a-b476-90291bc800f3/11_claude-5-model-deep-dive_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/93822c9d-be6a-4f9c-a9a1-a7b26c1aa07d/11_claude-5-model-deep-dive_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/49134df2-3044-4636-a562-2f3c5ed5c6c1/11_claude-5-model-deep-dive_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/43fcc49a-9fbc-4240-bfb3-f2c329ee2e5b/11_claude-5-model-deep-dive_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5698f793-8bfe-42ae-96db-b25e3e3a81bc/11_claude-5-model-deep-dive_08.jpg",
      ],
      designSystemId: "design-system:claude",
      templateId: "template:html-ppt-obsidian-claude-gradient",
    },
    {
      slug: "mixtral-next-moe-research",
      title: "Mixtral Next Moe Research",
      prompt:
        "/gen presentation with design system `mistral-ai` and template `html-ppt-tech-sharing`, create a Mixtral-Next mixture-of-experts research talk. Routing math, expert utilization charts, throughput benchmarks, open-weight policy, partner programs. Make it feel European, research, candid.",
      embedUrl: "https://mixtral-next-moe-research-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/142b780d-f808-487c-adf3-8985da1370b5/15.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5113d925-b751-4072-94d7-0283b2b6b1ee/12_mixtral-next-moe-research_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b71e9f1d-3718-4f19-93a7-d39abb14cb9c/12_mixtral-next-moe-research_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4d095081-0559-43d1-90df-3f941f94cd7d/12_mixtral-next-moe-research_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/97a05526-e62e-4940-b369-efe4fa495f9f/12_mixtral-next-moe-research_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c018a17a-b883-4718-ab2f-c6ddd838cc25/12_mixtral-next-moe-research_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9dbda2e8-d204-4664-b3ff-c325d8b223fd/12_mixtral-next-moe-research_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0068d5a6-3b05-48c6-bc08-e354e2205143/12_mixtral-next-moe-research_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/01b94554-9cc7-421d-b1aa-f1803c415a10/12_mixtral-next-moe-research_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/86c31210-7778-4cbb-b95e-a30c11997449/12_mixtral-next-moe-research_09.jpg",
      ],
      designSystemId: "design-system:mistral-ai",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "huggingface-state-of-the-hub",
      title: "Huggingface State Of The Hub",
      prompt:
        "/gen presentation with design system `huggingface` and template `html-ppt-zhangzara-creative-mode`, create an open model community state-of-the-hub annual recap. Downloads dashboard, top contributors, dataset spotlights, hub partnerships, roadmap. Make it feel warm, community, playful.",
      embedUrl: "https://huggingface-state-of-the-hub-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/94299487-0db8-422c-8072-6496caa17c6e/16.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/14ff40f9-b2c2-4a1e-9a87-444a3773e151/13_huggingface-state-of-the-hub_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bb6ba0b6-a620-4e0e-ab0b-c149fb86b41b/13_huggingface-state-of-the-hub_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6f90692f-15d7-4031-9734-f770e9d7be92/13_huggingface-state-of-the-hub_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62648899-ca33-4e0e-a0e6-bc4c5a043169/13_huggingface-state-of-the-hub_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/032cb9a1-5f54-44f6-a9e7-8fdb65f22c82/13_huggingface-state-of-the-hub_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/77c813a8-1d5e-440b-a0df-717bb449d880/13_huggingface-state-of-the-hub_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ded33633-d15c-4412-b753-3304c2b5f1da/13_huggingface-state-of-the-hub_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5cfa0f14-3517-4d05-81d6-e8efe8de9ced/13_huggingface-state-of-the-hub_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2974ff70-cc81-4061-80c3-9f20a55c1342/13_huggingface-state-of-the-hub_09.jpg",
      ],
      designSystemId: "design-system:huggingface",
      templateId: "template:html-ppt-zhangzara-creative-mode",
    },
    {
      slug: "grok-4-infra-disclosure",
      title: "Grok 4 Infra Disclosure",
      prompt:
        "/gen presentation with design system `x-ai` and template `html-ppt-hermes-cyber-terminal`, create a Grok 4 capability and infra disclosure. Training cluster, Colossus topology, tool use evals, deployment guardrails, public usage stats. Make it feel cyberpunk, terminal, bold.",
      embedUrl: "https://grok-4-infra-disclosure-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e3554d44-46c7-435e-a443-cc6104c0bf6a/17.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c8f6f802-05ee-4b3c-bf7a-6fe289d43836/14_grok-4-infra-disclosure_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2b4901d6-81ec-4c8a-909e-076425e100c7/14_grok-4-infra-disclosure_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b7239f86-17ef-4d35-97dc-6db8ab984aa1/14_grok-4-infra-disclosure_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fd530d98-7b10-45dc-9edf-8c93756dfe6e/14_grok-4-infra-disclosure_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3ed48c60-d363-40aa-b101-31d4ab66554e/14_grok-4-infra-disclosure_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/63f821d6-c073-4ee9-a9ed-dd95136001d6/14_grok-4-infra-disclosure_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1873f9e6-81ad-475f-8efe-01d2fef45bdc/14_grok-4-infra-disclosure_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f7edc3b0-e748-4b63-af57-5a09554947b1/14_grok-4-infra-disclosure_08.jpg",
      ],
      designSystemId: "design-system:x-ai",
      templateId: "template:html-ppt-hermes-cyber-terminal",
    },
    {
      slug: "minimax-m2-product-launch",
      title: "Minimax M2 Product Launch",
      prompt:
        "/gen presentation with design system `minimax` and template `html-ppt-xhs-white-editorial`, create a MiniMax M2 product launch deck. Multimodal samples, agent benchmarks, partner integrations, China-market rollout, pricing tiers. Make it feel pastel, modern, friendly.",
      embedUrl: "https://minimax-m2-product-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8621506b-3c2d-4348-b17e-9437dbe1076e/18.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ccb5a2ec-aa8d-4538-a1f0-c6ada650055e/15_minimax-m2-product-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/44d56857-cdaf-4732-9ecb-0a52546ddcd6/15_minimax-m2-product-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cd1b9f25-0f62-444d-a006-c7fc8f06a453/15_minimax-m2-product-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b23ea52e-8f21-4046-adb2-5eb0fd840da7/15_minimax-m2-product-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3638f7e7-8451-4b8f-b85f-c0a1122a1e27/15_minimax-m2-product-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3bd0e627-ea0a-49d7-b66c-a22d758482ad/15_minimax-m2-product-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8afe5807-a6ab-4b08-9ec2-371a218fa44e/15_minimax-m2-product-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e705412b-b431-4964-9b17-0c1e8097d192/15_minimax-m2-product-launch_08.jpg",
      ],
      designSystemId: "design-system:minimax",
      templateId: "template:html-ppt-xhs-white-editorial",
    },
    {
      slug: "nvidia-blackwell-ultra-arch",
      title: "NVIDIA Blackwell Ultra Arch",
      prompt:
        "/gen presentation with design system `nvidia` and template `html-ppt-knowledge-arch-blueprint`, create a Blackwell Ultra reference data-center architecture briefing. NVLink fabric, rack power profile, liquid cooling, cluster topology, MLPerf numbers. Make it feel architectural, high-performance, technical.",
      embedUrl: "https://nvidia-blackwell-ultra-arch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/5f97e72e-4065-4fa6-aa12-23f73f2d8eff/19.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4e666ef8-b564-46d1-8b0c-8f5b9b4c0f78/16_nvidia-blackwell-ultra-arch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b7898802-fffc-458a-9477-f8893894f671/16_nvidia-blackwell-ultra-arch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a2e107d-4652-4d6a-bfb6-6cbb0736b407/16_nvidia-blackwell-ultra-arch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2ccab8d8-89e7-4b7b-b219-fc03f97dc1ba/16_nvidia-blackwell-ultra-arch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4318827a-f22f-4ed5-8533-82f08a15e931/16_nvidia-blackwell-ultra-arch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ce9ab0b2-6965-4616-b88b-17f60f8003cc/16_nvidia-blackwell-ultra-arch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8c5bd532-9172-4e18-bd04-d1509923600b/16_nvidia-blackwell-ultra-arch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e674336e-22e8-451d-b3eb-9bb186577412/16_nvidia-blackwell-ultra-arch_08.jpg",
      ],
      designSystemId: "design-system:nvidia",
      templateId: "template:html-ppt-knowledge-arch-blueprint",
    },
    {
      slug: "ibm-consulting-hybrid-cloud-qbr",
      title: "IBM Consulting Hybrid Cloud QBR",
      prompt:
        "/gen presentation with design system `ibm` and template `html-ppt-weekly-report`, create an IBM Consulting hybrid-cloud QBR for a Fortune 100 client. Engagement KPIs, workload migration progress, FinOps savings, risk register, next-quarter roadmap. Make it feel corporate, measured, enterprise.",
      embedUrl: "https://ibm-consulting-hybrid-cloud-qbr-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3ec5a6ba-07b7-4c09-9ed1-bc677a37d5ec/20.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/50cbd981-35ab-4d3a-b869-991e4b3318ac/17_ibm-consulting-hybrid-cloud-qbr_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/abbd6f4c-8d0c-49f4-bc04-521423ef02d5/17_ibm-consulting-hybrid-cloud-qbr_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bcc86932-cd35-4068-a650-c46102b496d7/17_ibm-consulting-hybrid-cloud-qbr_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/eddb5950-f4d1-41e2-8f91-50283daaa3bf/17_ibm-consulting-hybrid-cloud-qbr_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/15196c42-37e9-4250-bb52-e43466bd020b/17_ibm-consulting-hybrid-cloud-qbr_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a73fd89c-3f0d-4f72-9bb5-587555ecd5a0/17_ibm-consulting-hybrid-cloud-qbr_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/771b9d47-88aa-4727-8d4a-5a057e8a072f/17_ibm-consulting-hybrid-cloud-qbr_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3b9c7605-1e2b-4b58-8c11-d587b2b94d8f/17_ibm-consulting-hybrid-cloud-qbr_08.jpg",
      ],
      designSystemId: "design-system:ibm",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "cisco-netops-weekly-status",
      title: "Cisco Netops Weekly Status",
      prompt:
        "/gen presentation with design system `cisco` and template `html-ppt-weekly-report`, create a global NetOps weekly status report. SLA dashboards, incident summary, capacity headroom, security posture, change calendar. Make it feel corporate, operational, clear.",
      embedUrl: "https://cisco-netops-weekly-status-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/80e3e6d7-62a6-497e-aca5-cac3d8bd451e/21.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c7c3d767-1bba-4eda-9fcc-c525bbfc89c8/18_cisco-netops-weekly-status_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/972ea7f1-d9b8-40fd-aa86-ea32eab6b80c/18_cisco-netops-weekly-status_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/89bd1df1-c1e6-48e0-883a-14ce37dc51d7/18_cisco-netops-weekly-status_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/83ea9169-030f-4710-bc7d-3c0adccd7a7a/18_cisco-netops-weekly-status_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8b80d2bc-83a4-4094-a018-eebf0f80bc06/18_cisco-netops-weekly-status_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/87b016ef-cbf1-4920-8e4a-1656cfbac466/18_cisco-netops-weekly-status_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d39f3fe2-93f9-46c1-8523-3cfc0a5135ae/18_cisco-netops-weekly-status_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0031aac1-87ff-4cb9-a6aa-601e8bed0ae6/18_cisco-netops-weekly-status_08.jpg",
      ],
      designSystemId: "design-system:cisco",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "meta-rayban-display-keynote",
      title: "Meta Rayban Display Keynote",
      prompt:
        "/gen presentation with design system `meta` and template `html-ppt-product-launch`, create a Ray-Ban Display launch keynote. Hardware specs, AI assistant demos, social capture stories, pricing tiers, retail rollout. Make it feel cinematic, social, premium.",
      embedUrl: "https://meta-rayban-display-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/095dfe2e-7506-4599-b154-e2ccdee3be88/22.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7496e7d-6788-4e40-9bb5-e2cc4c9c9886/19_meta-rayban-display-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/31771e24-ae6d-4a03-afc7-954ef6fc7f6d/19_meta-rayban-display-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/af2637c6-cf4a-48d6-acac-88ae0486476b/19_meta-rayban-display-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/31d891c3-cccf-478b-8450-4222b3157aaa/19_meta-rayban-display-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2410284a-574d-42e5-bd02-787aa1de3a09/19_meta-rayban-display-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e58bded-0803-41e3-a053-6929148ab971/19_meta-rayban-display-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5f94a0d8-4b18-47d4-950c-b0ccd491db61/19_meta-rayban-display-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bc0c961d-9681-4ae9-8dc7-9f2a7db6e10b/19_meta-rayban-display-keynote_08.jpg",
      ],
      designSystemId: "design-system:meta",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "discord-community-summit-2026",
      title: "Discord Community Summit 2026",
      prompt:
        "/gen presentation with design system `discord` and template `html-ppt-zhangzara-block-frame`, create a Discord platform 2026 community summit deck. New voice features, Activities SDK, creator monetization, moderator tools, partner spotlights. Make it feel playful, pastel-pop, community.",
      embedUrl: "https://discord-community-summit-2026-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/011e5901-06ef-4e90-a5ba-a63a595a032f/23.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b1a8b7e3-ab50-4edb-aa81-7671e172c0a7/20_discord-community-summit-2026_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5e4ddf89-b213-43ac-8a9d-a8b4fe694a20/20_discord-community-summit-2026_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/17dfaeda-a841-4b77-8f8a-2447db228643/20_discord-community-summit-2026_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9df6df7b-c210-4e2f-b691-f24ba193d5eb/20_discord-community-summit-2026_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d9b003f1-43dc-4cc3-81f5-813a4ff13afb/20_discord-community-summit-2026_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a6646295-9205-42de-a8ee-2a6be417a559/20_discord-community-summit-2026_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8fd35c62-ee11-4a77-9170-1d4ae01ff1bb/20_discord-community-summit-2026_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ed74cee2-4342-4c20-958c-e1955063f570/20_discord-community-summit-2026_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/68802d10-8394-4acd-89d0-a7fd08244bf7/20_discord-community-summit-2026_09.jpg",
      ],
      designSystemId: "design-system:discord",
      templateId: "template:html-ppt-zhangzara-block-frame",
    },
    {
      slug: "slack-enterprise-success-qbr",
      title: "Slack Enterprise Success QBR",
      prompt:
        "/gen presentation with design system `slack` and template `html-ppt-weekly-report`, create an enterprise customer success QBR for a 30k-seat account. Adoption metrics, channel health, integrations attached, automation hours saved, renewal motion. Make it feel corporate, friendly, structured.",
      embedUrl: "https://slack-enterprise-success-qbr-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a8945365-9f26-4516-aa2c-b53c552323ba/24.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1093a074-c4af-4b48-be1b-7888901ca383/21_slack-enterprise-success-qbr_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6a1195c1-d244-4385-9ae3-f4c6b7d67032/21_slack-enterprise-success-qbr_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d221150d-43d6-4f51-9b7b-544ecefe1284/21_slack-enterprise-success-qbr_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/55cb092a-9d3f-46e6-9549-d38dc9bc8671/21_slack-enterprise-success-qbr_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ec083065-bf89-4088-aa26-80f54ff12a25/21_slack-enterprise-success-qbr_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0015e048-f404-4a54-b846-2b078563fd19/21_slack-enterprise-success-qbr_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0a68a485-4360-476d-8ac6-4ed51c7b3e1c/21_slack-enterprise-success-qbr_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f13422cf-ddd4-43ae-9e27-793dfc0f60aa/21_slack-enterprise-success-qbr_08.jpg",
      ],
      designSystemId: "design-system:slack",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "notion-ai-pm-training-module",
      title: "Notion AI PM Training Module",
      prompt:
        "/gen presentation with design system `notion` and template `html-ppt-course-module`, create a Notion AI for product managers self-paced training module. Lesson outline, exercises, AI prompt library, project rubric, completion checklist. Make it feel warm, editorial, instructional.",
      embedUrl: "https://notion-ai-pm-training-module-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bc724eed-2d1a-4932-ad25-2cee58baf1d8/25.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6839fac4-e4f8-435d-ab2d-5c4064c82690/22_notion-ai-pm-training-module_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/aeb9e127-bc40-409b-87c7-f44e90bc52bd/22_notion-ai-pm-training-module_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5f3d9ec4-d4aa-444b-a2c5-3cd3703d46ca/22_notion-ai-pm-training-module_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e3dcb151-162e-4c66-a0eb-b905d70a9cb8/22_notion-ai-pm-training-module_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/42760f13-5e82-49e4-a8af-2df2b8dec84a/22_notion-ai-pm-training-module_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be0131a9-7d98-41aa-ad34-9872e3112328/22_notion-ai-pm-training-module_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/41342483-1e81-474e-94d6-c8ca76098c4a/22_notion-ai-pm-training-module_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3c9a0515-de24-4fa8-a8ff-f6bd2cba0fdb/22_notion-ai-pm-training-module_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b059a43a-9e9a-4eba-a244-25c87f472462/22_notion-ai-pm-training-module_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2067a1c7-b690-4436-961d-5bb5db2f1dfc/22_notion-ai-pm-training-module_10.jpg",
      ],
      designSystemId: "design-system:notion",
      templateId: "template:html-ppt-course-module",
    },
    {
      slug: "airbnb-icons-2027-host-pitch",
      title: "Airbnb Icons 2027 Host Pitch",
      prompt:
        "/gen presentation with design system `airbnb` and template `html-ppt-zhangzara-soft-editorial`, create an Airbnb Icons 2027 host pitch deck. Story collections, guest personas, photography moodboard, host requirements, payout economics. Make it feel warm, editorial, hospitable.",
      embedUrl: "https://airbnb-icons-2027-host-pitch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/90cfa844-955d-4759-9a19-285bb0f13bd3/26.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f4a82351-58db-4def-85e4-092ae093e9fd/23_airbnb-icons-2027-host-pitch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e5d106f3-0adb-424a-b2a2-803f37da5216/23_airbnb-icons-2027-host-pitch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f4e58244-1d38-4a67-a095-0dfa8c1574cf/23_airbnb-icons-2027-host-pitch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/525a68d3-208b-408b-b961-634de106e8bc/23_airbnb-icons-2027-host-pitch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a9b2b701-9dee-4381-a858-aae322bf9269/23_airbnb-icons-2027-host-pitch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0e7b280b-0370-47dc-8727-fd9748e92051/23_airbnb-icons-2027-host-pitch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7d5a2165-bb34-4c6e-84fb-8c6abdee9443/23_airbnb-icons-2027-host-pitch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6b1d1c6d-cec1-4414-a3f7-5214a8bf484b/23_airbnb-icons-2027-host-pitch_08.jpg",
      ],
      designSystemId: "design-system:airbnb",
      templateId: "template:html-ppt-zhangzara-soft-editorial",
    },
    {
      slug: "airtable-cobuilder-arch",
      title: "Airtable Cobuilder Arch",
      prompt:
        "/gen presentation with design system `airtable` and template `html-ppt-knowledge-arch-blueprint`, create an Airtable Cobuilder reference architecture briefing for enterprise IT. Data model, sync graph, automation engine, governance layer, rollout plan. Make it feel architectural, enterprise, blueprint-clean.",
      embedUrl: "https://airtable-cobuilder-arch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/35e83506-7f68-406c-a662-1ef451d46449/27.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0d3b3e2c-8564-4a7c-9ef5-171d160f719e/24_airtable-cobuilder-arch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0843685a-be36-4b29-9ebd-5d0f357c1f7e/24_airtable-cobuilder-arch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/84c558c0-cc97-48fb-b512-22f3934cf00f/24_airtable-cobuilder-arch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d5264545-0b6f-4d20-87a0-56c7041e7c3c/24_airtable-cobuilder-arch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/baf32233-9bbf-4536-897d-95feca3ff0c0/24_airtable-cobuilder-arch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/886c654d-0ab2-4f05-9443-7d997dbd8ebe/24_airtable-cobuilder-arch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/020bd0ed-8535-4f10-bf27-c3e1a8025fe3/24_airtable-cobuilder-arch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f4048dc2-070f-4e1e-872b-b2e6d39adda0/24_airtable-cobuilder-arch_08.jpg",
      ],
      designSystemId: "design-system:airtable",
      templateId: "template:html-ppt-knowledge-arch-blueprint",
    },
    {
      slug: "ant-design-v6-governance-review",
      title: "Ant Design V6 Governance Review",
      prompt:
        "/gen presentation with design system `ant` and template `html-ppt-weekly-report`, create an Ant Design System v6 internal governance review. Component adoption, theming changes, accessibility scores, release calendar, open issues. Make it feel structured, corporate, clear.",
      embedUrl: "https://ant-design-v6-governance-review-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/fa851b6d-3550-4cc4-a34b-1b399385d281/28.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5cffdd79-f9af-4860-b5bf-d1482894316d/25_ant-design-v6-governance-review_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/373029f2-08f9-4d77-938e-a0147e6d47d2/25_ant-design-v6-governance-review_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3ba7de66-1c12-474e-adf0-21e292cd2457/25_ant-design-v6-governance-review_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d62a30b6-dbb5-4827-ac09-bcf154a1dee5/25_ant-design-v6-governance-review_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/50f831c4-48bf-454d-968a-931d99644f23/25_ant-design-v6-governance-review_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/00ca0dd3-85d6-4496-890f-2d2f4e2963fc/25_ant-design-v6-governance-review_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3c061a92-5cf5-45ed-994d-d85e54e839bb/25_ant-design-v6-governance-review_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/66dbc18c-12c6-4b53-bc67-ae4761420963/25_ant-design-v6-governance-review_08.jpg",
      ],
      designSystemId: "design-system:ant",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "canva-design-ai-allhands",
      title: "Canva Design AI Allhands",
      prompt:
        "/gen presentation with design system `canva` and template `html-ppt-zhangzara-creative-mode`, create a Canva Design AI for marketers all-hands deck. New magic features, brand kits, education program, case studies, roadmap. Make it feel colorful, friendly, energetic.",
      embedUrl: "https://canva-design-ai-allhands-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/92ef7561-884e-438b-8f90-74c3b035e356/30.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/64bc7718-b004-4c7e-963d-e1822c9b0028/26_canva-design-ai-allhands_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4f1a33e9-bf17-4ba8-a992-c53377625a61/26_canva-design-ai-allhands_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8b8f7385-9cf5-4ef9-869c-f95b2eed00fa/26_canva-design-ai-allhands_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e6b88cc-6b3a-4124-b964-0fe641f8ff2b/26_canva-design-ai-allhands_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0f582b63-d880-470f-a372-2546febf7b91/26_canva-design-ai-allhands_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8e33d0a2-b650-438b-adc3-06279c694cdf/26_canva-design-ai-allhands_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/65f1fb15-8b03-4bb8-8df8-e580c623bc8d/26_canva-design-ai-allhands_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ef5fc132-7ab1-4ceb-b864-795cb06344bc/26_canva-design-ai-allhands_08.jpg",
      ],
      designSystemId: "design-system:canva",
      templateId: "template:html-ppt-zhangzara-creative-mode",
    },
    {
      slug: "clickhouse-query-performance-talk",
      title: "Clickhouse Query Performance Talk",
      prompt:
        "/gen presentation with design system `clickhouse` and template `html-ppt-tech-sharing`, create a ClickHouse Cloud query-performance deep-dive conference talk. JOIN reordering, parallel replicas, S3 cold tier, benchmark vs Snowflake, optimization recipes. Make it feel technical, candid, performance.",
      embedUrl:
        "https://clickhouse-query-performance-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b126c3a6-5f8b-4731-af1c-5d89b18498de/31.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9322c6a7-3f82-46cd-8c6c-2190f8085376/27_clickhouse-query-performance-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6c6f296e-c5c0-410b-bdce-85747b41d1c1/27_clickhouse-query-performance-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a11478a1-4aa1-4efa-8735-8e238caa6e62/27_clickhouse-query-performance-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/479e4d6e-d25f-48ac-afb2-b90471316f96/27_clickhouse-query-performance-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/23cb7073-5e0d-442b-ba6e-41fc619dcceb/27_clickhouse-query-performance-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3bbec1a0-15fb-46d3-bd8e-3eea1ba99942/27_clickhouse-query-performance-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d6b18f49-7dbc-4c05-82c6-571387cf446c/27_clickhouse-query-performance-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7f255ccd-f827-4308-93fe-4bc245a80daa/27_clickhouse-query-performance-talk_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d8f20185-a345-40ef-8328-ff6924b2ef26/27_clickhouse-query-performance-talk_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7c058d1a-6ba3-4de4-a25f-ef2d069e2f55/27_clickhouse-query-performance-talk_10.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a2f327cd-3cd2-4b30-997e-e38cdfe7dac8/27_clickhouse-query-performance-talk_11.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/96555848-c149-42d4-80c4-e6a6cddd8fab/27_clickhouse-query-performance-talk_12.jpg",
      ],
      designSystemId: "design-system:clickhouse",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "coinbase-institutional-prime-deck",
      title: "Coinbase Institutional Prime",
      prompt:
        "/gen presentation with design system `coinbase` and template `html-ppt-pitch-deck`, create a Coinbase Institutional prime-brokerage sales deck. AUC scale, custody architecture, OTC desk, derivatives roadmap, regulatory posture. Make it feel institutional, sleek, blue-chip.",
      embedUrl:
        "https://coinbase-institutional-prime-deck-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/532a8473-5a1d-4656-95fb-17e909cf754b/32.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6ec66655-db99-4fde-9cb2-4dda8479d609/28_coinbase-institutional-prime-deck_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/adcc7248-d6d8-4ba7-8a33-1ccfa33fdcd2/28_coinbase-institutional-prime-deck_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ff26cd46-e601-4225-8fa6-ed37a0503834/28_coinbase-institutional-prime-deck_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/db5e938e-13af-4b14-a4df-17c78073a563/28_coinbase-institutional-prime-deck_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a4702ac5-a04b-4d6c-90aa-da080b35cc9c/28_coinbase-institutional-prime-deck_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6eba5cf9-46f9-4624-a26d-b7cda02a73c4/28_coinbase-institutional-prime-deck_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/433d4b33-3060-486a-ac44-0bc78c4fbe81/28_coinbase-institutional-prime-deck_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/aa46fbc2-31c7-4619-af81-74f1c11b26cd/28_coinbase-institutional-prime-deck_08.jpg",
      ],
      designSystemId: "design-system:coinbase",
      templateId: "template:html-ppt-pitch-deck",
    },
    {
      slug: "composio-agent-tooling-arch",
      title: "Composio Agent Tooling Arch",
      prompt:
        "/gen presentation with design system `composio` and template `html-ppt-knowledge-arch-blueprint`, create a Composio agent-tooling reference architecture for an enterprise prospect. Tool registry, auth proxy, sandboxing layer, observability, integration matrix. Make it feel architectural, technical, clean.",
      embedUrl: "https://composio-agent-tooling-arch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0062e788-a1d0-4c71-9f30-d20f1a3c05a3/33.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/30e5796a-5dd3-465a-870c-88477a0ef66e/29_composio-agent-tooling-arch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/006bb17a-06b8-4b2e-ad2e-c670db860bb5/29_composio-agent-tooling-arch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7c4ee4f-203f-45eb-bc04-99970cad81a6/29_composio-agent-tooling-arch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d0cae9aa-7d0d-4b79-97fd-f8c2aa10a907/29_composio-agent-tooling-arch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c6553701-1405-4c63-896f-d774eb2c5448/29_composio-agent-tooling-arch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/15e260d9-8927-48f1-b749-7df5e97d41d7/29_composio-agent-tooling-arch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be7114c2-e63d-4ba4-a8d6-66da0679a030/29_composio-agent-tooling-arch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f0cdebd2-3d71-4207-9b17-99681ed5090d/29_composio-agent-tooling-arch_08.jpg",
      ],
      designSystemId: "design-system:composio",
      templateId: "template:html-ppt-knowledge-arch-blueprint",
    },
    {
      slug: "cursor-1-0-developer-conf",
      title: "Cursor 1 0 Developer Conf",
      prompt:
        "/gen presentation with design system `cursor` and template `html-ppt-tech-sharing`, create a Cursor 1.0 developer conference talk. Agent mode demo, codebase indexing, MCP support, enterprise SSO, pricing. Make it feel developer, sleek, confident.",
      embedUrl: "https://cursor-1-0-developer-conf-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b3f72a45-54c6-4fa7-a837-3f9ce0133a8a/34.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8524faa5-b77f-443e-8fb4-a99036dc31c7/30_cursor-1-0-developer-conf_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f4ee8404-44e8-49f6-b5d8-08d7afad7dbb/30_cursor-1-0-developer-conf_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/234c1db5-70b5-4cf9-8dcd-b8a6ef94e3c0/30_cursor-1-0-developer-conf_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8b17d202-54a7-44fb-ab2d-2bf2e393cce5/30_cursor-1-0-developer-conf_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7636959a-7f65-4595-a7f0-e10b3de018a0/30_cursor-1-0-developer-conf_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e6086564-3650-4243-9dd8-f64e2ffa3dca/30_cursor-1-0-developer-conf_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be0b7f62-7c63-41c2-a889-7b0070c867f9/30_cursor-1-0-developer-conf_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ce3e5751-5314-4a46-b543-a70c7ed17d73/30_cursor-1-0-developer-conf_08.jpg",
      ],
      designSystemId: "design-system:cursor",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "duolingo-math-parents-launch",
      title: "Duolingo Math Parents Launch",
      prompt:
        "/gen presentation with design system `duolingo` and template `html-ppt-zhangzara-daisy-days`, create a Duolingo Math launch deck for parents and educators. Curriculum scope, gamification mechanics, parent dashboard, school program, pricing. Make it feel cheerful, friendly, family.",
      embedUrl: "https://duolingo-math-parents-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/61647e04-a82f-47f3-8f86-a995395b2195/35.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6bd00ad6-960f-4fbe-bcb2-4c1b630be6cf/31_duolingo-math-parents-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/376bbbfa-803b-46fa-bc3b-615406dd2904/31_duolingo-math-parents-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2da296dd-a2ab-4485-852c-262ed1b031a0/31_duolingo-math-parents-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bb5a1fd1-398c-447f-814c-7a44d15d46c4/31_duolingo-math-parents-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/84269631-831c-4139-b352-976ca6639ae1/31_duolingo-math-parents-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7a6a894f-802c-468a-942d-eeba3d9ac132/31_duolingo-math-parents-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5f9fbb46-ce10-4c5c-8e37-9b1beb759e4b/31_duolingo-math-parents-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dc0cd469-c802-4838-956b-02869c8fa8a3/31_duolingo-math-parents-launch_08.jpg",
      ],
      designSystemId: "design-system:duolingo",
      templateId: "template:html-ppt-zhangzara-daisy-days",
    },
    {
      slug: "elevenlabs-voice-3-keynote",
      title: "Elevenlabs Voice 3 Keynote",
      prompt:
        "/gen presentation with design system `elevenlabs` and template `html-ppt-product-launch`, create an ElevenLabs Voice 3 model launch keynote. Sample reel, latency benchmarks, voice cloning policy, agent voices, pricing tiers. Make it feel premium, voice-forward, sleek.",
      embedUrl: "https://elevenlabs-voice-3-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/72d4b7c9-a05a-4cb7-9f52-abe46a768abe/36.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1f4aa6ea-4d7b-4477-815e-0ce289c0db52/32_elevenlabs-voice-3-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e083f1bb-4811-4ef5-bd11-43627d632a26/32_elevenlabs-voice-3-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b778af80-04fe-4cf6-b1ad-8b38082f63ab/32_elevenlabs-voice-3-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f997f62d-79cf-4271-97ac-debd94cb5b5d/32_elevenlabs-voice-3-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f2f764bd-edf7-4202-bd43-3a8a00df42f4/32_elevenlabs-voice-3-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0a3f4f23-6fd3-47a3-8820-b2c517722ded/32_elevenlabs-voice-3-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9cb37e1d-ed10-4331-9761-1cb07973d63e/32_elevenlabs-voice-3-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/00a04670-a81f-4cea-bcfd-6d944d69f0ef/32_elevenlabs-voice-3-keynote_08.jpg",
      ],
      designSystemId: "design-system:elevenlabs",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "expo-router-v5-conf-talk",
      title: "Expo Router V5 Conf Talk",
      prompt:
        "/gen presentation with design system `expo` and template `html-ppt-tech-sharing`, create an Expo Router v5 conference talk. New routing primitives, server components, EAS updates, performance wins, migration guide. Make it feel developer, friendly, technical.",
      embedUrl: "https://expo-router-v5-conf-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0ff00890-6c31-4649-8103-7e96e3a60908/37.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/126fe73a-fc11-46bc-aad3-861fe0517a9a/33_expo-router-v5-conf-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ceb99ae6-a39a-42d9-b2a2-a8019957a585/33_expo-router-v5-conf-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d99f8e5d-f48b-4cbc-8621-58e3d80fadd9/33_expo-router-v5-conf-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/986bec00-1a52-45e5-9a96-127a9160c5fa/33_expo-router-v5-conf-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9644ec78-09be-4082-be63-ff547581d6d0/33_expo-router-v5-conf-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0823f552-14bb-4583-9d39-b6da8f8fafe7/33_expo-router-v5-conf-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4d5be4a9-4419-4969-9629-10124aad8afc/33_expo-router-v5-conf-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/969a3916-c1ee-40bb-8ebb-095288fb5059/33_expo-router-v5-conf-talk_08.jpg",
      ],
      designSystemId: "design-system:expo",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "framer-ai-sites-2026-launch",
      title: "Framer AI Sites 2026 Launch",
      prompt:
        "/gen presentation with design system `framer` and template `html-ppt-product-launch`, create a Framer AI Sites 2026 launch deck. Prompt-to-site demo, CMS, SEO panel, e-commerce add-on, pricing. Make it feel design, friendly, fast.",
      embedUrl: "https://framer-ai-sites-2026-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/945ff862-f11f-4055-bfc7-220d007897fe/39.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3214857c-f22e-49e7-b472-45087a04c908/34_framer-ai-sites-2026-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/65dd496d-c7d6-469d-a02e-ceab8591c262/34_framer-ai-sites-2026-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cb0e414a-a31d-41a8-8a62-1c8288d8c579/34_framer-ai-sites-2026-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e3907dad-fb7a-49d2-a7e5-db2fb810c338/34_framer-ai-sites-2026-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0c72dea8-3b54-4de9-a9f4-6a85283b1a98/34_framer-ai-sites-2026-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2d4c1866-5b85-4c83-a820-bec04cfd7ea2/34_framer-ai-sites-2026-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/45964264-fd51-4f12-aaf7-ddfc05f8c6dd/34_framer-ai-sites-2026-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3c19824c-d05c-4530-9b02-2c452c239b94/34_framer-ai-sites-2026-launch_08.jpg",
      ],
      designSystemId: "design-system:framer",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "github-universe-copilot-keynote",
      title: "Github Universe Copilot Keynote",
      prompt:
        "/gen presentation with design system `github` and template `html-ppt-tech-sharing`, create a GitHub Universe Copilot Workspace keynote. Issue-to-PR flow, plan-edit-test loop, enterprise rollout, security posture, customer wins. Make it feel developer, candid, confident.",
      embedUrl: "https://github-universe-copilot-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d176742c-6d72-4e5d-8bce-ebe01e548a2f/40.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d17a4b5a-6892-43be-bc2d-0c0cad7c6271/35_github-universe-copilot-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6c8b40a4-8356-4f25-b159-7087b4501457/35_github-universe-copilot-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/114f6c41-67b0-44a0-823b-778eab83a801/35_github-universe-copilot-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5a396ec0-3acf-4eb5-a421-7d57cceba441/35_github-universe-copilot-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dd32bc2e-a2e3-4f00-867d-59fc99a377aa/35_github-universe-copilot-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/65699bb5-3a7e-4e49-9f71-a90eaff47b8d/35_github-universe-copilot-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/172447d5-94e3-4472-aa56-274fe83dac3d/35_github-universe-copilot-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6275f1df-13fc-4cdc-b5c8-ed986565b7c7/35_github-universe-copilot-keynote_08.jpg",
      ],
      designSystemId: "design-system:github",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "terraform-stacks-bank-arch",
      title: "Terraform Stacks Bank Arch",
      prompt:
        "/gen presentation with design system `hashicorp` and template `html-ppt-knowledge-arch-blueprint`, create a Terraform Stacks reference deployment architecture for a bank. Stack topology, state isolation, policy guardrails, CI/CD pipeline, migration plan. Make it feel architectural, enterprise, precise.",
      embedUrl: "https://terraform-stacks-bank-arch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/557b3c8a-75d6-48af-b3d1-c7952f7d77cd/41.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bd4dda4d-230f-4d40-975e-15e77facc4fd/36_terraform-stacks-bank-arch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e39dab37-b025-4316-9eff-ed22326ba924/36_terraform-stacks-bank-arch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb9c2d16-2a1f-490c-a0d6-3e7109f9ba2a/36_terraform-stacks-bank-arch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5ab11ef4-cc23-408f-8cd1-a071c5f66726/36_terraform-stacks-bank-arch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b10332ca-3c70-4a94-a530-8b6862f5702f/36_terraform-stacks-bank-arch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f9d90532-15cf-48d2-942b-834760ea37c8/36_terraform-stacks-bank-arch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2eb5ac4a-ad12-4ccd-96ea-bc10108e9d26/36_terraform-stacks-bank-arch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/deb7c81f-c772-4b7a-8ecb-da0e368744d5/36_terraform-stacks-bank-arch_08.jpg",
      ],
      designSystemId: "design-system:hashicorp",
      templateId: "template:html-ppt-knowledge-arch-blueprint",
    },
    {
      slug: "intercom-fin-ai-agent-sales",
      title: "Intercom Fin AI Agent Sales",
      prompt:
        "/gen presentation with design system `intercom` and template `html-ppt-pitch-deck`, create an Intercom Fin AI Agent enterprise sales deck. Deflection rate proof, integrations, governance controls, pricing model, customer wins. Make it feel modern, friendly, sales.",
      embedUrl: "https://intercom-fin-ai-agent-sales-715f6d07.sites.vm0.io",
      previewImage:
        "https://presentation-gallery-previews-715f6d07.sites.vm0.io/intercom-fin-ai-agent-sales.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7be9d2a1-5d0b-4d43-9225-2f15bac6ab35/37_intercom-fin-ai-agent-sales_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3730a07c-bacc-423f-992e-b19eb68168bb/37_intercom-fin-ai-agent-sales_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c2be9fe6-f3bd-45e4-9018-2c75bf46d375/37_intercom-fin-ai-agent-sales_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fa1f4a8c-f0a4-49ea-9867-bafdcbed27e0/37_intercom-fin-ai-agent-sales_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/63b6746d-bcc8-4f43-9d48-f58575e1677a/37_intercom-fin-ai-agent-sales_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/671ef84f-6cf8-45c6-9591-0465346bd887/37_intercom-fin-ai-agent-sales_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9a180687-ee43-45fd-a1bb-f5303329efe8/37_intercom-fin-ai-agent-sales_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dfc92c10-dd96-4265-a0df-de3d76ea5e0a/37_intercom-fin-ai-agent-sales_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d4c189d-0ad5-4662-ba0e-85bf13e85181/37_intercom-fin-ai-agent-sales_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2a94d24d-b8af-49f9-83f9-8cbddf65f2b6/37_intercom-fin-ai-agent-sales_10.jpg",
      ],
      designSystemId: "design-system:intercom",
      templateId: "template:html-ppt-pitch-deck",
    },
    {
      slug: "kraken-pro-flash-crash-postmortem",
      title: "Kraken Pro Flash Crash Postmortem",
      prompt:
        "/gen presentation with design system `kraken` and template `html-ppt-hermes-cyber-terminal`, create a Kraken Pro trading platform internal post-mortem on a flash-crash incident. Timeline, order book state, throttle decisions, customer comms, remediation. Make it feel terminal, candid, technical.",
      embedUrl:
        "https://kraken-pro-flash-crash-postmortem-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/a1e56c73-d52c-42e2-925b-6d402cc170b2/43.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f795c4df-ac27-47c4-9bec-54d2afc66ccf/38_kraken-pro-flash-crash-postmortem_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9c028841-4e85-40f4-9bf1-8081bc34f945/38_kraken-pro-flash-crash-postmortem_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c872acdc-50d2-41b4-8d73-798c3d505e07/38_kraken-pro-flash-crash-postmortem_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7aeb5f63-921f-4118-93ac-151db1e648c7/38_kraken-pro-flash-crash-postmortem_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3b6bc462-bed6-4739-8644-a78087eeee1c/38_kraken-pro-flash-crash-postmortem_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/20077cf6-4b38-4b25-985a-dd1b9a791504/38_kraken-pro-flash-crash-postmortem_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cd00bbc3-f799-4493-a68a-9bc221a2ebc6/38_kraken-pro-flash-crash-postmortem_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/05a8c878-b5a9-46be-b728-401591e9544a/38_kraken-pro-flash-crash-postmortem_08.jpg",
      ],
      designSystemId: "design-system:kraken",
      templateId: "template:html-ppt-hermes-cyber-terminal",
    },
    {
      slug: "linear-product-intelligence-keynote",
      title: "Linear Product Intelligence Keynote",
      prompt:
        "/gen presentation with design system `linear-app` and template `html-ppt-presenter-mode-reveal`, create a Linear Product Intelligence launch keynote. New insights view, AI triage, roadmap canvas, customer wins, pricing tiers. Make it feel modern, sleek, confident.",
      embedUrl:
        "https://linear-product-intelligence-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/05efce44-a920-46e9-a47e-d759e727b4dc/45.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1827fb4e-0730-4bf1-b806-8fb1dcdc089d/39_linear-product-intelligence-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e5385fb3-1b58-4921-836b-0780d327dc57/39_linear-product-intelligence-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/790b0396-72dd-4ab6-82a0-73df1b711ebd/39_linear-product-intelligence-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8bc1d3b9-85bb-4fbd-bd08-8a74f2871625/39_linear-product-intelligence-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/37295c38-80d9-4f16-bb36-106692fb9d91/39_linear-product-intelligence-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/48344232-f762-421d-9398-a0f03521b855/39_linear-product-intelligence-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/733703dc-01fa-446f-bde4-1367c0ae4fb4/39_linear-product-intelligence-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f539ae25-c932-4429-9e7c-9923f36e336a/39_linear-product-intelligence-keynote_08.jpg",
      ],
      designSystemId: "design-system:linear-app",
      templateId: "template:html-ppt-presenter-mode-reveal",
    },
    {
      slug: "lingo-localization-ops-training",
      title: "Lingo Localization Ops Training",
      prompt:
        "/gen presentation with design system `lingo` and template `html-ppt-course-module`, create a Lingo localization-ops onboarding training module for translators. Workflow walkthrough, glossary, QA checks, payout calendar, certification path. Make it feel warm, instructional, friendly.",
      embedUrl: "https://lingo-localization-ops-training-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8a0ae449-2f40-40dd-b449-9a4abd2f9037/46.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dd3a6f68-9f8d-49d0-a786-aa7fa324c064/40_lingo-localization-ops-training_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/05fec6ae-95b7-4f73-acaf-b3fc3539a5ae/40_lingo-localization-ops-training_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/37b7a0b4-dc13-4a27-868c-a8a20d85befe/40_lingo-localization-ops-training_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/16b4e83b-9bce-4767-8d7d-337f9e775ee3/40_lingo-localization-ops-training_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/25462880-d9cc-4f10-9045-3535e63dbc14/40_lingo-localization-ops-training_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/53beb4de-ab6b-4980-8499-3e08a5d6fc7a/40_lingo-localization-ops-training_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/706ee876-49d4-4645-9fb5-a14333c34951/40_lingo-localization-ops-training_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/eaed2544-84cc-4d80-aebc-6cd00bc99f33/40_lingo-localization-ops-training_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a21ece1b-01d6-4765-95b0-fb6f95308874/40_lingo-localization-ops-training_09.jpg",
      ],
      designSystemId: "design-system:lingo",
      templateId: "template:html-ppt-course-module",
    },
    {
      slug: "loom-ai-workflows-launch",
      title: "Loom AI Workflows Launch",
      prompt:
        "/gen presentation with design system `loom` and template `html-ppt-product-launch`, create a Loom AI Workflows launch deck. Auto-summary, action items, integrations, enterprise SSO, pricing. Make it feel friendly, modern, video-first.",
      embedUrl: "https://loom-ai-workflows-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/ce0a6d49-6ccb-4d4a-b4ad-01812bfd5228/47.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/81d83f91-0ad6-4e0e-b331-e57f13f6205d/41_loom-ai-workflows-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/64bbb8bd-cf1d-4245-9844-bd90ec916c59/41_loom-ai-workflows-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/18af1c3f-2611-4e7a-90c1-7cb61739d5bd/41_loom-ai-workflows-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/403a313c-8c3a-4da6-b896-cd3904a0e4f1/41_loom-ai-workflows-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a9681ebe-cb0f-4610-8ffa-d59fffbd83d2/41_loom-ai-workflows-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c5db458e-2866-41b8-ae3a-83d4cd17ceb5/41_loom-ai-workflows-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/26509576-5be5-4515-a99c-29bf3ad1bd86/41_loom-ai-workflows-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0e6afe7c-21bd-402f-ab60-5a8b2fd39186/41_loom-ai-workflows-launch_08.jpg",
      ],
      designSystemId: "design-system:loom",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "mastercard-fraud-risk-council",
      title: "Mastercard Fraud Risk Council",
      prompt:
        "/gen presentation with design system `mastercard` and template `html-ppt-weekly-report`, create a Mastercard fraud-risk weekly council report. Authorization-decline trends, model performance, geo heatmap, issuer alerts, control changes. Make it feel corporate, structured, financial.",
      embedUrl: "https://mastercard-fraud-risk-council-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/bcf655e2-83a9-4f84-ab41-8882a8b7d86b/49.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1eacb9eb-99f2-49fa-9dff-65175079c7c8/42_mastercard-fraud-risk-council_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/642979f7-141c-4cc8-afad-2486633ccfa5/42_mastercard-fraud-risk-council_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c9f1f0bb-73e0-4e08-bc97-8d0a8497cdf2/42_mastercard-fraud-risk-council_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ab85b552-d5ed-40e0-a387-f0a4b369526a/42_mastercard-fraud-risk-council_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bba30059-7559-444f-b8aa-08c43b736cce/42_mastercard-fraud-risk-council_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/35de8b3b-cae2-42de-917b-e26ed115c082/42_mastercard-fraud-risk-council_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/425f1119-9bea-4e75-a4d3-819c30371730/42_mastercard-fraud-risk-council_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f4717592-026b-4622-abb3-f2cb7a060fd6/42_mastercard-fraud-risk-council_08.jpg",
      ],
      designSystemId: "design-system:mastercard",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "mintlify-docs-writing-workshop",
      title: "Mintlify Docs Writing Workshop",
      prompt:
        "/gen presentation with design system `mintlify` and template `html-ppt-course-module`, create a Mintlify docs-writing workshop deck for new technical writers. Module outline, examples, exercise prompts, peer review, certification. Make it feel warm, editorial, instructional.",
      embedUrl: "https://mintlify-docs-writing-workshop-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/50c6bf39-0fe5-4419-87bc-a146fefab1f2/50.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f4b6280a-3fbf-4a64-bd8d-eea7b8789c7b/43_mintlify-docs-writing-workshop_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7cf31a2b-1cd6-4bbb-bc47-3d4666ef0a3c/43_mintlify-docs-writing-workshop_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3e2481d5-b5ef-4e4c-907c-87e99e2b0ebd/43_mintlify-docs-writing-workshop_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8ec48a18-e254-43f7-bdc0-2b65b912d84d/43_mintlify-docs-writing-workshop_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/50d63d8d-e11d-4dc2-a338-05550feb292f/43_mintlify-docs-writing-workshop_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/246c16ea-0b54-4fcc-9d44-19093068d536/43_mintlify-docs-writing-workshop_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d30148a4-1b76-4716-88cc-c21fd3aa7874/43_mintlify-docs-writing-workshop_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2d547236-9155-4204-81ec-5936bcd0307c/43_mintlify-docs-writing-workshop_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/564ee8eb-ceab-41b4-8346-d4e7eb8308eb/43_mintlify-docs-writing-workshop_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/269dcb0b-b258-4531-947e-fba9b14ea3c0/43_mintlify-docs-writing-workshop_10.jpg",
      ],
      designSystemId: "design-system:mintlify",
      templateId: "template:html-ppt-course-module",
    },
    {
      slug: "miro-innovation-workshop",
      title: "Miro Innovation Workshop",
      prompt:
        "/gen presentation with design system `miro` and template `html-ppt-zhangzara-scatterbrain`, create a Miro Innovation Workspace customer co-creation workshop deck. Discovery board, opportunity map, prototype sticky notes, voting matrix, next steps. Make it feel post-it, playful, workshop.",
      embedUrl: "https://miro-innovation-workshop-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b1894363-094a-49b8-bb2c-06f8c08ff4e4/51.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6c19ab15-b5f0-4f0a-a623-ce7dbbb59e88/44_miro-innovation-workshop_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ef225da6-cedf-4b8c-8921-70383ff2ba3c/44_miro-innovation-workshop_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8f5d2616-c127-4911-a988-66bcc5e44b62/44_miro-innovation-workshop_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/302554f9-ec8d-4a41-8558-4463d0f55f0e/44_miro-innovation-workshop_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d5242979-c811-4346-be56-4f5cb36206cd/44_miro-innovation-workshop_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/66a66f3f-edeb-48b4-892e-c51416d92139/44_miro-innovation-workshop_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7c4168e0-4c18-4bbe-ad84-9355ed8f6916/44_miro-innovation-workshop_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ccb858c3-1261-45b4-a3ef-16f36884f001/44_miro-innovation-workshop_08.jpg",
      ],
      designSystemId: "design-system:miro",
      templateId: "template:html-ppt-zhangzara-scatterbrain",
    },
    {
      slug: "mongodb-atlas-vector-search-talk",
      title: "Mongodb Atlas Vector Search Talk",
      prompt:
        "/gen presentation with design system `mongodb` and template `html-ppt-tech-sharing`, create a MongoDB Atlas Vector Search conference talk. Index internals, hybrid search, embedding refresh, benchmark numbers, customer wins. Make it feel technical, candid, database.",
      embedUrl:
        "https://mongodb-atlas-vector-search-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://presentation-gallery-previews-715f6d07.sites.vm0.io/mongodb-atlas-vector-search-talk.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e6261c83-98c6-433e-88a5-f12be2a15ccb/45_mongodb-atlas-vector-search-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/21bc2fb7-1043-4bfb-81c4-fc0290481aa4/45_mongodb-atlas-vector-search-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2cb662bd-4c29-41d2-bf83-264107c7fd94/45_mongodb-atlas-vector-search-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d0aef468-e8db-4db5-860d-2f610cb3d259/45_mongodb-atlas-vector-search-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/22551d37-a82c-4050-927e-2a212e165415/45_mongodb-atlas-vector-search-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ad674958-538c-4646-a503-fecd39e022c0/45_mongodb-atlas-vector-search-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/86f56a12-f98c-4705-a4f1-78add68d2ea2/45_mongodb-atlas-vector-search-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/368c5dc9-1225-4d9b-bcac-67317867144b/45_mongodb-atlas-vector-search-talk_08.jpg",
      ],
      designSystemId: "design-system:mongodb",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "ollama-on-device-community-talk",
      title: "Ollama On Device Community Talk",
      prompt:
        "/gen presentation with design system `ollama` and template `html-ppt-hermes-cyber-terminal`, create an Ollama on-device deployment community talk. Model zoo, GPU profile guide, quantization tradeoffs, MCP integration, roadmap. Make it feel terminal, indie, technical.",
      embedUrl: "https://ollama-on-device-community-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7722d6a7-af35-428d-a10d-09204f717049/53.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2deb7515-d9e1-4f3e-8c88-fc692c4fb066/46_ollama-on-device-community-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ca8a7320-bbab-4a0b-8dd0-aa6216055e79/46_ollama-on-device-community-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7adec237-d376-447b-9d1d-c51ad6951f5d/46_ollama-on-device-community-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/de35888d-0779-41d3-9b0c-59acf6557d9b/46_ollama-on-device-community-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d2d909ef-dcf5-4ebd-947b-71cc7354b8a8/46_ollama-on-device-community-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/353fab67-e4b5-4104-b158-b4dc08a1196d/46_ollama-on-device-community-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1aff4141-d728-45b5-aea1-9f9312ebca77/46_ollama-on-device-community-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cab4e2fd-c0b6-4ece-967e-2dff7e2f040b/46_ollama-on-device-community-talk_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/56162b45-edfe-4b5c-9bbc-09a31bbcdcc7/46_ollama-on-device-community-talk_09.jpg",
      ],
      designSystemId: "design-system:ollama",
      templateId: "template:html-ppt-hermes-cyber-terminal",
    },
    {
      slug: "perplexity-pages-comet-keynote",
      title: "Perplexity Pages Comet Keynote",
      prompt:
        "/gen presentation with design system `perplexity` and template `html-ppt-product-launch`, create a Perplexity Pages and Comet browser launch keynote. New page editor, agent browsing, pricing tiers, partner publishers, growth. Make it feel sleek, modern, research.",
      embedUrl: "https://perplexity-pages-comet-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/cdfe86fd-b14a-4571-a763-25d7ab97211f/54.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1509b684-f259-4e1f-ae41-ae0ab3a9a69a/47_perplexity-pages-comet-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d8d6b25-e66c-4b59-916c-2dfa18c40cc4/47_perplexity-pages-comet-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/396ba974-a3e9-4560-bf24-e0a29a2832c6/47_perplexity-pages-comet-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ea6bc0f8-cde4-4a8c-a60b-b19ee961e497/47_perplexity-pages-comet-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7b6e3a86-0e68-470a-ab00-521bc14f5a0a/47_perplexity-pages-comet-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2af3d7bf-07ff-47d4-8655-3ccb7a859153/47_perplexity-pages-comet-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8ea9b8cd-5658-45a9-b285-4875ed94ddbe/47_perplexity-pages-comet-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/821289d1-5c75-4c64-8c6f-00ec681d152e/47_perplexity-pages-comet-keynote_08.jpg",
      ],
      designSystemId: "design-system:perplexity",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "posthog-product-eng-metrics-talk",
      title: "Posthog Product Eng Metrics Talk",
      prompt:
        "/gen presentation with design system `posthog` and template `html-ppt-tech-sharing`, create a PostHog product-engineering metrics conference talk. North-star tree, experiments velocity, retention curves, error budgets, recipes. Make it feel candid, technical, indie.",
      embedUrl:
        "https://posthog-product-eng-metrics-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d902c52c-0f07-4bd3-b04e-b5466270b303/56.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b2b75b4b-212f-4be9-bfab-68b3ffbbb58f/48_posthog-product-eng-metrics-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4ab29a2e-d2bd-4ba3-80c8-6e8bc2bf0437/48_posthog-product-eng-metrics-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b33f1796-29b7-46cc-8e9b-06f098fe3f96/48_posthog-product-eng-metrics-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f109af31-44a2-4f7e-bb33-a70c2c84f528/48_posthog-product-eng-metrics-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/90736eb6-4ef0-4894-a728-c1b822aeeaae/48_posthog-product-eng-metrics-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/da00046a-85c8-4a19-9f69-d0a404e9739d/48_posthog-product-eng-metrics-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e41a786d-128d-4c45-82a0-26c2fab62261/48_posthog-product-eng-metrics-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6c837686-6208-422a-b084-d158754f317b/48_posthog-product-eng-metrics-talk_08.jpg",
      ],
      designSystemId: "design-system:posthog",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "raycast-for-teams-keynote",
      title: "Raycast For Teams Keynote",
      prompt:
        "/gen presentation with design system `raycast` and template `html-ppt-product-launch`, create a Raycast for Teams launch keynote. Shared snippets, AI commands, team analytics, pricing tiers, enterprise readiness. Make it feel sleek, premium, developer.",
      embedUrl: "https://raycast-for-teams-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d1ddd039-157b-4d43-b706-b41b5687b652/57.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/afb29459-5620-4a47-ae4e-ad8b0c6c2a3c/49_raycast-for-teams-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3e4ac727-02fc-4ebc-9438-fd0aa0adcc7f/49_raycast-for-teams-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a1c59b1-092b-48f3-b542-66e3fe37fd0c/49_raycast-for-teams-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/89424a6e-441f-46ea-a71b-0643729eea27/49_raycast-for-teams-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d6c8743f-3381-4e0c-adf3-b2d5722df030/49_raycast-for-teams-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/afdb52ca-c5e5-4396-a0a6-5c9b3beabfd8/49_raycast-for-teams-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/371652c2-6c45-4e34-a795-21842db6bf31/49_raycast-for-teams-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1cd67fca-13ed-4031-bc76-dd3a72e98f10/49_raycast-for-teams-keynote_08.jpg",
      ],
      designSystemId: "design-system:raycast",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "replicate-model-serving-infra-talk",
      title: "Replicate Model Serving Infra Talk",
      prompt:
        "/gen presentation with design system `replicate` and template `html-ppt-tech-sharing`, create a Replicate model-serving infra deep-dive talk. Cold-start architecture, scheduler, GPU bin packing, cost economics, roadmap. Make it feel technical, candid, infra.",
      embedUrl:
        "https://replicate-model-serving-infra-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/84acedce-ae03-4477-8380-e89366d3b4eb/58.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3fd97da4-dd46-4709-9052-8c9f5432a544/50_replicate-model-serving-infra-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4e910f59-5987-4037-b6dd-943f8dba581d/50_replicate-model-serving-infra-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a191d52-cb75-4ca6-8c0a-a45e224a72d7/50_replicate-model-serving-infra-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/34ab3105-2f51-4370-86ae-045057740075/50_replicate-model-serving-infra-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/27d84580-7823-4db8-91a9-3fb7ffa106d4/50_replicate-model-serving-infra-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4b6faa4c-e841-44d7-9786-78ddeb0f9cbe/50_replicate-model-serving-infra-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/460403b9-a771-4e80-8692-35aa726d7ac5/50_replicate-model-serving-infra-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b52451a3-7c75-4132-947c-1cf05c88886c/50_replicate-model-serving-infra-talk_08.jpg",
      ],
      designSystemId: "design-system:replicate",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "resend-broadcasts-2-launch",
      title: "Resend Broadcasts 2 Launch",
      prompt:
        "/gen presentation with design system `resend` and template `html-ppt-product-launch`, create a Resend Broadcasts 2.0 launch deck. New editor, segmentation, deliverability dashboard, pricing, customer wins. Make it feel modern, friendly, developer.",
      embedUrl: "https://resend-broadcasts-2-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/be7d2295-742d-408b-80dc-21fe731cce40/59.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/25dff294-9a9b-443b-a497-6966a1320a27/51_resend-broadcasts-2-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0455201c-8370-4d55-ba08-1e93b46f8602/51_resend-broadcasts-2-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/191c1901-942a-4eee-a3ac-f32a1f863d39/51_resend-broadcasts-2-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/65f941bf-d376-41ea-b264-ce603bd404f2/51_resend-broadcasts-2-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7212ebb9-f1b9-4fc9-8a42-cf4ecb276bc6/51_resend-broadcasts-2-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5eccf74f-7d67-409f-a9fd-89c4f4e2a00a/51_resend-broadcasts-2-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8bb57025-4636-4c08-8687-09524941ea8b/51_resend-broadcasts-2-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/79ec7d97-53e5-48b9-9d97-fd36da7ee5cb/51_resend-broadcasts-2-launch_08.jpg",
      ],
      designSystemId: "design-system:resend",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "revolut-business-latam-update",
      title: "Revolut Business Latam Update",
      prompt:
        "/gen presentation with design system `revolut` and template `html-ppt-pitch-deck`, create a Revolut Business expansion-to-LATAM investor update. Market sizing, regulatory path, product wedge, unit economics, hiring plan. Make it feel sleek, fintech, confident.",
      embedUrl: "https://revolut-business-latam-update-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/e1d12fd2-f2c9-445c-b2e2-d9ac9bc0e323/60.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/351b0928-93bf-4027-888f-3ec882acb325/52_revolut-business-latam-update_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1525fbf6-65e0-4165-a1d7-86497b64a0ea/52_revolut-business-latam-update_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d3eacbe2-cb85-4fff-8357-e19081f9681c/52_revolut-business-latam-update_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/349d480a-1523-4043-9282-3a06a56abb9f/52_revolut-business-latam-update_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/91608f04-0ca2-492a-abcc-ae6b9df373ff/52_revolut-business-latam-update_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f88a14df-096b-49f5-abac-0488b605e374/52_revolut-business-latam-update_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3ae3aad1-f23a-4a06-82d1-9dd8e37a96e1/52_revolut-business-latam-update_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0a4da588-cb85-4e0c-9eb4-ec0445f6319f/52_revolut-business-latam-update_08.jpg",
      ],
      designSystemId: "design-system:revolut",
      templateId: "template:html-ppt-pitch-deck",
    },
    {
      slug: "shopify-magic-merchants-launch",
      title: "Shopify Magic Merchants Launch",
      prompt:
        "/gen presentation with design system `shopify` and template `html-ppt-product-launch`, create a Shopify Magic for Merchants summer edition launch deck. AI tools demo, store templates, payment updates, merchant case studies, pricing. Make it feel friendly, modern, commerce.",
      embedUrl: "https://shopify-magic-merchants-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://presentation-gallery-previews-715f6d07.sites.vm0.io/shopify-magic-merchants-launch.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6819d395-f9b6-4efc-afcc-8b80f8fb360c/53_shopify-magic-merchants-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/04722759-d4bd-49fc-883d-b414077d520e/53_shopify-magic-merchants-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c55892ed-ddce-497a-8845-9460ad84bedd/53_shopify-magic-merchants-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d34911d6-bb5a-4cfe-8648-2a02ec299ec9/53_shopify-magic-merchants-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7b0349dd-7b3d-424a-b36a-9c0156fb317a/53_shopify-magic-merchants-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/309762da-b40f-47e4-b492-84f641605e39/53_shopify-magic-merchants-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/481c1ba7-56e0-4405-aae8-e87c45d7624d/53_shopify-magic-merchants-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/509aaa9c-7ba0-49cc-aa84-294e8323b9a4/53_shopify-magic-merchants-launch_08.jpg",
      ],
      designSystemId: "design-system:shopify",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "starbucks-reserve-brand-book",
      title: "Starbucks Reserve Brand Book",
      prompt:
        "/gen presentation with design system `starbucks` and template `html-ppt-zhangzara-mat`, create a Starbucks Reserve global brand book unveil. Bean story, store design language, beverage rituals, art collaborations, market rollout. Make it feel warm, refined, cafe.",
      embedUrl: "https://starbucks-reserve-brand-book-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/39b10cfa-0b55-4bf5-a724-f06bd2532c96/66.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b076ea7b-3bbc-4e87-850e-ea99d6feaa9a/54_starbucks-reserve-brand-book_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/40bcb596-36ff-48b8-a14b-41b2a10e1a63/54_starbucks-reserve-brand-book_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/303a4e9e-bba3-47ee-a9a7-f5f90faeb5b7/54_starbucks-reserve-brand-book_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/85c842bf-9b34-4c3d-81d7-9f6f22cf7843/54_starbucks-reserve-brand-book_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2ea46ea1-f594-4e55-bbc0-69fed5f2d277/54_starbucks-reserve-brand-book_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/64917d31-ccea-437d-8af9-4d3b2ecbf5ba/54_starbucks-reserve-brand-book_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d0543ac2-327d-4ddf-b611-94b73094f255/54_starbucks-reserve-brand-book_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e6d3e28f-4ae3-4be0-9066-8fae69a9b33c/54_starbucks-reserve-brand-book_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/aca24d28-f680-4ca5-96cc-9315707230ee/54_starbucks-reserve-brand-book_09.jpg",
      ],
      designSystemId: "design-system:starbucks",
      templateId: "template:html-ppt-zhangzara-mat",
    },
    {
      slug: "stripe-marketplace-arch",
      title: "Stripe Marketplace Arch",
      prompt:
        "/gen presentation with design system `stripe` and template `html-ppt-knowledge-arch-blueprint`, create a Stripe platform reference architecture for a marketplace. Account model, Connect flows, Tax engine, Radar, settlement timeline. Make it feel architectural, fintech, precise.",
      embedUrl: "https://stripe-marketplace-arch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/c01c5814-b72b-43cc-92b6-2adc339208e1/67.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/80463251-6ad4-4cc2-a19c-11bea8ef87d3/55_stripe-marketplace-arch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b043bebc-cc78-49ef-adb4-352af1b783b1/55_stripe-marketplace-arch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/66079fe1-8a4c-4edf-b1c5-b3546232f27d/55_stripe-marketplace-arch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bc82f368-6768-49da-aa36-0093d57dd1a6/55_stripe-marketplace-arch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2fdc85e2-ae10-43eb-bcf1-5c623d6a3264/55_stripe-marketplace-arch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2757ab50-05e8-4b05-8ed5-69c6fca5713f/55_stripe-marketplace-arch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ad64631f-ecf7-4d60-b921-c317a2a26537/55_stripe-marketplace-arch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/989845c2-cb31-4aab-abc3-f53b91a6e4d5/55_stripe-marketplace-arch_08.jpg",
      ],
      designSystemId: "design-system:stripe",
      templateId: "template:html-ppt-knowledge-arch-blueprint",
    },
    {
      slug: "supabase-postgres-17-talk",
      title: "Supabase Postgres 17 Talk",
      prompt:
        "/gen presentation with design system `supabase` and template `html-ppt-tech-sharing`, create a Supabase Postgres 17 features conference talk. Foreign data wrappers, vector index, realtime improvements, edge functions, customer wins. Make it feel developer, candid, open-source.",
      embedUrl: "https://supabase-postgres-17-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/07108888-9c2b-4891-a43e-dd2b3f228601/68.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/54683477-6f59-4b47-96a5-9f9410e6cd9f/56_supabase-postgres-17-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/33a71d31-88c4-465f-a67d-aa77cb541332/56_supabase-postgres-17-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d28d6e1f-857c-4cee-ab4a-114ff780a6f6/56_supabase-postgres-17-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c94cc1c7-d245-42d3-8066-35c1382c93f9/56_supabase-postgres-17-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a306ab1c-73a2-4e3c-907d-8476399e8f41/56_supabase-postgres-17-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1594e9c3-57be-40aa-9cc4-14218c1b1ef6/56_supabase-postgres-17-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/31111e5d-c794-4d00-acb1-92e2e105976b/56_supabase-postgres-17-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/00362db9-4225-4b2d-8982-c02140101381/56_supabase-postgres-17-talk_08.jpg",
      ],
      designSystemId: "design-system:supabase",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "superhuman-ai-inbox-launch",
      title: "Superhuman AI Inbox Launch",
      prompt:
        "/gen presentation with design system `superhuman` and template `html-ppt-product-launch`, create a Superhuman AI Inbox launch deck. New triage flow, command palette, calendar integration, pricing tiers, testimonials. Make it feel premium, sleek, productivity.",
      embedUrl: "https://superhuman-ai-inbox-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/3e7493d6-a916-4487-a54f-a6c34bda9e4b/69.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/890dadf0-a6d8-4449-9f42-e8c1401af49c/57_superhuman-ai-inbox-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/df9a7aff-ba89-46a8-9633-a083f42b1c7b/57_superhuman-ai-inbox-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/acba4da0-a633-4c87-a9ba-bfaee60d9410/57_superhuman-ai-inbox-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6fbc8e7a-c56f-49a2-9774-f67ff5c81fe5/57_superhuman-ai-inbox-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ddcbbfbd-0cc9-40b3-b031-80fc66682ea0/57_superhuman-ai-inbox-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/21ac78c1-c8ef-4261-b3a4-ffa4d0194e09/57_superhuman-ai-inbox-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6ff38963-baf5-4627-aaae-84e15307a6f0/57_superhuman-ai-inbox-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0339ddbd-acfa-4d26-bb0f-3e2f60eb8375/57_superhuman-ai-inbox-launch_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8e28092c-c277-4600-8dea-26eb9262ee7c/57_superhuman-ai-inbox-launch_09.jpg",
      ],
      designSystemId: "design-system:superhuman",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "together-inference-engine-talk",
      title: "Together Inference Engine Talk",
      prompt:
        "/gen presentation with design system `together-ai` and template `html-ppt-tech-sharing`, create a Together Inference Engine performance research talk. Speculative decoding, KV cache reuse, MLPerf benchmarks, partner stories, roadmap. Make it feel research, technical, candid.",
      embedUrl: "https://together-inference-engine-talk-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d95e2199-9581-4a6d-a4bc-755958ed049e/70.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9f59cfc8-ec4d-4a73-8a1b-987d2f2b2b42/58_together-inference-engine-talk_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5468ad83-9539-421d-8343-51e781afd2f9/58_together-inference-engine-talk_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9bfe3438-60ec-4afb-ac3d-7edfc903dbab/58_together-inference-engine-talk_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ff50d9f9-cf74-4719-a87c-fb91d2005936/58_together-inference-engine-talk_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e25712b9-09c0-4658-a7a0-e64bf38ee3ed/58_together-inference-engine-talk_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6670209f-2a18-4dc3-9cd8-522aaff2d95d/58_together-inference-engine-talk_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/89bc0f3a-92e8-42d6-a8dd-3979e1b90c45/58_together-inference-engine-talk_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/12e636ae-6077-4f2e-9af5-03b7e9268e03/58_together-inference-engine-talk_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7723504c-7097-4b8f-9822-82c875e4f606/58_together-inference-engine-talk_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6e973fb5-1af4-45fd-8d77-d1743553c019/58_together-inference-engine-talk_10.jpg",
      ],
      designSystemId: "design-system:together-ai",
      templateId: "template:html-ppt-tech-sharing",
    },
    {
      slug: "vercel-v0-ga-enterprise-launch",
      title: "Vercel V0 GA Enterprise Launch",
      prompt:
        "/gen presentation with design system `vercel` and template `html-ppt-product-launch`, create a Vercel v0 GA enterprise launch deck. New site builder, AI workflow, design partner stories, pricing, enterprise controls. Make it feel sleek, modern, developer.",
      embedUrl: "https://vercel-v0-ga-enterprise-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/39a7aaf1-6451-4de4-bc45-10946e335ed8/72.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d6197a9-c67e-4016-925d-cf825dbc48e5/59_vercel-v0-ga-enterprise-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/45952c25-f75d-47db-b013-c879b6092304/59_vercel-v0-ga-enterprise-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2d530581-9a24-4378-8740-bd7b53ead44a/59_vercel-v0-ga-enterprise-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/530680cf-a5b5-4de6-a77c-4705d9d4b63e/59_vercel-v0-ga-enterprise-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0dfa7c05-233c-43b9-8faf-c4d1bc472441/59_vercel-v0-ga-enterprise-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5c6a7bf6-f97c-498d-bfce-fea32d01ab0a/59_vercel-v0-ga-enterprise-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8bcd2b62-e392-49cc-8288-17e94e86b940/59_vercel-v0-ga-enterprise-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ced0653a-10f9-4c65-801d-cefe4cb9c69b/59_vercel-v0-ga-enterprise-launch_08.jpg",
      ],
      designSystemId: "design-system:vercel",
      templateId: "template:html-ppt-product-launch",
    },
    {
      slug: "vodafone-enterprise-services-qbr",
      title: "Vodafone Enterprise Services QBR",
      prompt:
        "/gen presentation with design system `vodafone` and template `html-ppt-weekly-report`, create a Vodafone enterprise-services QBR for a multinational client. SLA scorecards, network performance, security posture, change calendar, roadmap. Make it feel corporate, telco, structured.",
      embedUrl:
        "https://vodafone-enterprise-services-qbr-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/92f37d04-443d-4639-83a9-33c0328634ee/73.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/503313d7-7936-441d-a6da-4c0326f24394/60_vodafone-enterprise-services-qbr_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7118673e-f2bd-4d6f-9c15-c12b65a0780e/60_vodafone-enterprise-services-qbr_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/67bfcdec-73da-49a2-9893-ab34e05f3ac3/60_vodafone-enterprise-services-qbr_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/96b59d8d-a95b-4077-b4bb-8ebda1e17c35/60_vodafone-enterprise-services-qbr_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f45ed608-0fac-495a-895b-5aef1bfdc674/60_vodafone-enterprise-services-qbr_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0ac60987-9f63-47b4-9f1a-b11934609e0a/60_vodafone-enterprise-services-qbr_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a7784457-ac13-4c70-a085-b89f982548ea/60_vodafone-enterprise-services-qbr_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/40c56e2f-e62d-4661-9c26-27623e8fd8b7/60_vodafone-enterprise-services-qbr_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a72cd054-4c8d-48c0-aba7-41b84bc4a973/60_vodafone-enterprise-services-qbr_09.jpg",
      ],
      designSystemId: "design-system:vodafone",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "webex-contact-center-qbr",
      title: "Webex Contact Center QBR",
      prompt:
        "/gen presentation with design system `webex` and template `html-ppt-weekly-report`, create a Webex Contact Center QBR for a Fortune 500 client. Adoption stats, AI agent attach, queue performance, NPS, renewal plan. Make it feel corporate, professional, clear.",
      embedUrl: "https://webex-contact-center-qbr-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/8e6b8007-f214-44b1-b91e-e127154ee0df/74.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b418ff92-0986-4a48-bc89-bf4db75cf4e7/61_webex-contact-center-qbr_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/40a453a2-2aed-475d-b8a4-c1ad83331121/61_webex-contact-center-qbr_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4dd13a60-0b8b-4961-9bef-f7deb489c1a7/61_webex-contact-center-qbr_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3f0d95d9-3066-42e2-a5d6-1d742e9e1374/61_webex-contact-center-qbr_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/642c481c-a182-4972-8942-30f6519d3f7b/61_webex-contact-center-qbr_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1538220b-9e5e-46d5-9ad1-65eaa66405b1/61_webex-contact-center-qbr_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0308983c-9665-4808-9eb6-4afadbd2f0dc/61_webex-contact-center-qbr_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ac67082b-b7e1-41c0-af81-14c65910b8e1/61_webex-contact-center-qbr_08.jpg",
      ],
      designSystemId: "design-system:webex",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "webflow-conf-2026-keynote",
      title: "Webflow Conf 2026 Keynote",
      prompt:
        "/gen presentation with design system `webflow` and template `html-ppt-zhangzara-creative-mode`, create a Webflow Conf 2026 keynote deck. Designer 2 release, AI site builder, CMS upgrades, partner showcase, ecosystem stats. Make it feel colorful, design, energetic.",
      embedUrl: "https://webflow-conf-2026-keynote-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/82705e3b-4ca9-4353-9628-78ef9a566ab2/75.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f64b6be7-397e-4bad-9886-2e7cbf0ec09b/62_webflow-conf-2026-keynote_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/694e2364-8d47-41a8-9e5b-c27f39138f63/62_webflow-conf-2026-keynote_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/795ca6d6-d94e-4b31-a653-f6ac9705e54e/62_webflow-conf-2026-keynote_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ac7c48de-c085-4439-bbfe-935cf6fd3ad8/62_webflow-conf-2026-keynote_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fd5f0015-13af-4afb-83a4-b1854c685368/62_webflow-conf-2026-keynote_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/98469f77-6661-4fbc-a444-46447fa0eade/62_webflow-conf-2026-keynote_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ec2e7932-4ac6-41ef-a91b-10b252b87500/62_webflow-conf-2026-keynote_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be0fe337-5f39-45fa-974b-112db58555dd/62_webflow-conf-2026-keynote_08.jpg",
      ],
      designSystemId: "design-system:webflow",
      templateId: "template:html-ppt-zhangzara-creative-mode",
    },
    {
      slug: "saas-revops-weekly-metrics",
      title: "Saas Revops Weekly Metrics",
      prompt:
        "/gen presentation with design system `dashboard` and template `html-ppt-weekly-report`, create a SaaS revops weekly metrics review. ARR waterfall, pipeline coverage, win rate by segment, churn cohort, forecast call. Make it feel corporate, data-dense, clear.",
      embedUrl: "https://saas-revops-weekly-metrics-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/2bfd342f-d627-4164-9550-1f3e7a927ade/81.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/23810b8e-5d7a-41aa-8c49-5db20e5c7824/63_saas-revops-weekly-metrics_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/81d4c31f-0ae1-4277-9d48-082d2b8913c9/63_saas-revops-weekly-metrics_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c03a8556-5be8-4c28-8cec-13a34a58e1d5/63_saas-revops-weekly-metrics_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/20a42d9e-ccaf-4b7f-a349-118aae7e2974/63_saas-revops-weekly-metrics_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0f33e565-9bea-48c5-8cea-252c6ff87d9f/63_saas-revops-weekly-metrics_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/37f5ac2a-efcb-4518-8cd3-15f56a38adaa/63_saas-revops-weekly-metrics_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/95b42917-3614-4a73-9412-e9572a986d6d/63_saas-revops-weekly-metrics_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/96529ef8-289e-4bc8-b383-a4f2f4544ec9/63_saas-revops-weekly-metrics_08.jpg",
      ],
      designSystemId: "design-system:dashboard",
      templateId: "template:html-ppt-weekly-report",
    },
    {
      slug: "craft-coffee-feature-pitch",
      title: "Craft Coffee Feature Pitch",
      prompt:
        "/gen presentation with design system `warm-editorial` and template `html-ppt-taste-editorial`, create a long-form magazine feature pitch on the future of craft coffee. Story arc, photography moodboard, sources, columnist quotes, publishing schedule. Make it feel warm, editorial, hairline.",
      embedUrl: "https://craft-coffee-feature-pitch-715f6d07.sites.vm0.io",
      previewImage:
        "https://presentation-gallery-previews-715f6d07.sites.vm0.io/craft-coffee-feature-pitch.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/976d462b-3c44-48cf-a96f-e9b26af48469/64_craft-coffee-feature-pitch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/157adeba-436c-49c9-9647-8d079c506764/64_craft-coffee-feature-pitch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d36f2b9b-cf0e-4475-806e-4fafaca0521e/64_craft-coffee-feature-pitch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d4f5f81b-522f-4bef-85b1-9d88f7ced2f6/64_craft-coffee-feature-pitch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cf6fb0c6-1727-4a3e-98c9-0b99bbf26953/64_craft-coffee-feature-pitch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/54215abe-58da-4aba-b250-dd7b440dddd1/64_craft-coffee-feature-pitch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5b0216e9-f164-49b6-b9ba-a4b83a1f483a/64_craft-coffee-feature-pitch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/db33bef6-a0a1-436c-87e6-17d3cc7a1a0b/64_craft-coffee-feature-pitch_08.jpg",
      ],
      designSystemId: "design-system:warm-editorial",
      templateId: "template:html-ppt-taste-editorial",
    },
    {
      slug: "nym-year-in-review",
      title: "NYM Year In Review",
      prompt:
        "/gen presentation with design system `editorial` and template `html-ppt-taste-editorial`, create a New York Magazine year-in-review staff readout. Hero stories, traffic anatomy, subscriber growth, editorial wins, 2027 commissions. Make it feel editorial, considered, refined.",
      embedUrl: "https://nym-year-in-review-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4152c201-0a30-40e8-9106-5f6238386dfc/84.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2545d64f-5356-4353-a242-6ac0975468dd/65_nym-year-in-review_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/eb38c46e-0f90-4015-9afc-9a9e07e8882d/65_nym-year-in-review_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c73d2c30-32c4-4724-9d0b-99774f8a76f7/65_nym-year-in-review_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/472f83ec-2823-4407-b32b-7c996dc660ad/65_nym-year-in-review_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/70e3bad6-53ea-44a2-85da-5a65f1c5be32/65_nym-year-in-review_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/79e2c304-a669-493e-98bb-c09212c170b1/65_nym-year-in-review_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4494b568-1bc0-4fb2-b4ab-6d4c9729a76b/65_nym-year-in-review_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6d14490b-06f9-41a8-8b4b-02a151ea81b6/65_nym-year-in-review_08.jpg",
      ],
      designSystemId: "design-system:editorial",
      templateId: "template:html-ppt-taste-editorial",
    },
    {
      slug: "indie-author-book-launch",
      title: "Indie Author Book Launch",
      prompt:
        "/gen presentation with design system `mono` and template `html-ppt-zhangzara-monochrome`, create an indie author book launch deck. Synopsis, character map, reader personas, tour cities, press kit. Make it feel monochrome, literary, considered.",
      embedUrl: "https://indie-author-book-launch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/01a16f1d-66d9-4bf3-acb3-6fa2850adae9/85.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c5c2a80c-2f18-433a-b1bf-de07a47d94d5/66_indie-author-book-launch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5c08c45c-a784-4b8d-8f56-39dd262948b6/66_indie-author-book-launch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5f1b63ba-54d4-4251-9f14-9d4be4981b81/66_indie-author-book-launch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6762442b-c308-4791-a34a-823f3ee5a532/66_indie-author-book-launch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6829cf88-9235-492a-a886-918d19bf9532/66_indie-author-book-launch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dae9b0bf-5a5b-4962-97ba-fe2ac991c8a6/66_indie-author-book-launch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/df850b36-9e2c-4179-bb45-ef351baa5853/66_indie-author-book-launch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cdb05f28-5e7f-4a06-99f9-18e657c60fd6/66_indie-author-book-launch_08.jpg",
      ],
      designSystemId: "design-system:mono",
      templateId: "template:html-ppt-zhangzara-monochrome",
    },
    {
      slug: "agent-system-architecture-readout",
      title: "Agent System Architecture Readout",
      prompt:
        "/gen presentation with design system `agentic` and template `html-ppt-graphify-dark-graph`, create an internal agent-system architecture readout for an enterprise platform team. Agent graph, tool registry, eval harness, observability, rollout plan. Make it feel dark, graph-driven, technical.",
      embedUrl:
        "https://agent-system-architecture-readout-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/6cd9a0f3-44bb-42ca-8ce1-2704dc924f57/86.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cd981374-b7d2-4694-bcda-216173200c40/67_agent-system-architecture-readout_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b88b485e-2954-4db8-8e9f-04a163e11d27/67_agent-system-architecture-readout_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9844aa51-55da-43f4-abd8-22dc54f11c7c/67_agent-system-architecture-readout_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/89f502fe-fe16-4ce5-ab5f-6bded1b57fb3/67_agent-system-architecture-readout_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d25d6aca-2db0-4288-94cd-ccf4d9fccba6/67_agent-system-architecture-readout_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2a0d42a8-4411-4d3b-8292-417cdf141069/67_agent-system-architecture-readout_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0e7c3973-e9d8-47d7-bafc-1fca12b23d7f/67_agent-system-architecture-readout_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3a6c45bf-9d1f-4f06-8dbe-37dff069bd07/67_agent-system-architecture-readout_08.jpg",
      ],
      designSystemId: "design-system:agentic",
      templateId: "template:html-ppt-graphify-dark-graph",
    },
    {
      slug: "creative-portfolio-capsule-pitch",
      title: "Creative Portfolio Capsule Pitch",
      prompt:
        "/gen presentation with design system `bento` and template `html-ppt-zhangzara-capsule`, create a personal portfolio pitch for a multi-disciplinary creative. Project capsules, skills grid, client logos, testimonial pulls, contact card. Make it feel capsule, lifestyle, friendly.",
      embedUrl:
        "https://creative-portfolio-capsule-pitch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/7e546395-0103-499b-ba2a-5e565e8411f0/87.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3fa85255-ce8f-41c0-8a6a-352b94920212/68_creative-portfolio-capsule-pitch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2690ad42-ec3b-4a14-9897-22cf48b5059b/68_creative-portfolio-capsule-pitch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/692d840e-29a0-4c5e-bf5c-56d4f8044ca1/68_creative-portfolio-capsule-pitch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c5390b54-0a7d-49fd-94d4-343cdc987fd5/68_creative-portfolio-capsule-pitch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dea5ca5c-39f6-4361-aa54-e7acfc732df4/68_creative-portfolio-capsule-pitch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c8330fb6-3cb5-4cce-9eef-0518767bbfb3/68_creative-portfolio-capsule-pitch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d89c9382-8dae-4b64-ab6a-4fdd9fa946ba/68_creative-portfolio-capsule-pitch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f7b189dc-1971-4c9e-97ca-e6bae1a7df15/68_creative-portfolio-capsule-pitch_08.jpg",
      ],
      designSystemId: "design-system:bento",
      templateId: "template:html-ppt-zhangzara-capsule",
    },
    {
      slug: "protest-poster-history-capstone",
      title: "Protest Poster History Capstone",
      prompt:
        "/gen presentation with design system `brutalism` and template `html-ppt-zhangzara-raw-grid`, create a graphic-design-school capstone presentation on protest poster history. Era timeline, case studies, typography study, field photography, final thesis. Make it feel raw-grid, brutalist, academic.",
      embedUrl: "https://protest-poster-history-capstone-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/0a7fe625-5627-4bc7-8e5c-3393933beae7/88.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/709621c2-e0b1-4a15-82ce-967a670bbfff/69_protest-poster-history-capstone_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6f0ba0fb-a627-4f01-9b72-d61c6192fc23/69_protest-poster-history-capstone_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/38c0c08b-4bb0-4555-b5a7-42d16b862182/69_protest-poster-history-capstone_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5de563e9-6e72-4d72-8e6d-3b2e9c34b51a/69_protest-poster-history-capstone_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/15cddfc3-86fd-490f-9d36-71b9bc0e5ee1/69_protest-poster-history-capstone_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb841924-65c9-4caa-889d-fd70993c3260/69_protest-poster-history-capstone_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/80407146-1081-435d-8c31-47a8163a093d/69_protest-poster-history-capstone_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7c84d4f6-f5ad-415f-8c28-918520353a72/69_protest-poster-history-capstone_08.jpg",
      ],
      designSystemId: "design-system:brutalism",
      templateId: "template:html-ppt-zhangzara-raw-grid",
    },
    {
      slug: "wellness-app-annual-story",
      title: "Wellness App Annual Story",
      prompt:
        "/gen presentation with design system `claymorphism` and template `html-ppt-xhs-pastel-card`, create a wellness-app subscriber annual story. Habit streaks, sleep gains, mindful minutes, community moments, next-year ritual. Make it feel pastel, soft, calming.",
      embedUrl: "https://wellness-app-annual-story-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/d988d8e6-f736-4257-bec6-6e52f83ce978/89.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/05490101-9535-49d2-b955-9d0a72ca546f/70_wellness-app-annual-story_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d95d611e-f849-42e2-8883-701335a4c314/70_wellness-app-annual-story_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c552dbdf-cd8a-4eec-a6e8-ade0f2cdef31/70_wellness-app-annual-story_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3d0bb4f2-f44f-43e4-a31a-501846a4770c/70_wellness-app-annual-story_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/44c8b8c5-3d79-4c05-a0fe-212f7f462b20/70_wellness-app-annual-story_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e9a9b0b7-5c49-4e03-87c3-3595578b20dd/70_wellness-app-annual-story_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bb1dd7df-be8a-4020-911d-39b5a9e87899/70_wellness-app-annual-story_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d7b64322-488a-4b06-bb5f-c80c2791a4a1/70_wellness-app-annual-story_08.jpg",
      ],
      designSystemId: "design-system:claymorphism",
      templateId: "template:html-ppt-xhs-pastel-card",
    },
    {
      slug: "kindergarten-family-yearbook",
      title: "Kindergarten Family Yearbook",
      prompt:
        "/gen presentation with design system `clay` and template `html-ppt-zhangzara-daisy-days`, create a kindergarten family-yearbook reveal for parents. Class moments, art highlights, milestone chart, teacher notes, summer plans. Make it feel cheerful, friendly, family.",
      embedUrl: "https://kindergarten-family-yearbook-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/4bdd62fa-5919-46ae-9a62-9f8a146f0b22/90.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c8208c3d-07fd-484a-b0bc-f5c30174d8c2/71_kindergarten-family-yearbook_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/61c04d90-3ee7-4b2e-80cd-afdca5900d00/71_kindergarten-family-yearbook_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b00b9399-e069-47a7-b2b8-6eb2e2cff6af/71_kindergarten-family-yearbook_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9a0036c4-9191-460e-9222-12499da153e4/71_kindergarten-family-yearbook_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/67215f31-9ad9-4856-b99e-8916bb222f15/71_kindergarten-family-yearbook_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/756005db-f2f0-4c99-af38-e440de9767db/71_kindergarten-family-yearbook_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/74aee040-4f98-4ce7-811c-2a7d7445425b/71_kindergarten-family-yearbook_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/80f05c00-276c-4d56-8444-e55a8117314c/71_kindergarten-family-yearbook_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fc906ee8-d459-4f07-8540-6b9622f3cf92/71_kindergarten-family-yearbook_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9f44a155-9472-46fa-ae2f-02580dfb312f/71_kindergarten-family-yearbook_10.jpg",
      ],
      designSystemId: "design-system:clay",
      templateId: "template:html-ppt-zhangzara-daisy-days",
    },
    {
      slug: "indie-pixel-game-press-deck",
      title: "Indie Pixel Game Press",
      prompt:
        "/gen presentation with design system `cosmic` and template `html-ppt-zhangzara-8-bit-orbit`, create an indie video game pre-launch press deck. Story pitch, gameplay loop, art direction, soundtrack samples, release window. Make it feel pixel, neon, gaming.",
      embedUrl: "https://indie-pixel-game-press-deck-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/aab12986-5c0e-4cd8-aa2e-7609b6534f05/91.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dacc9dbd-126e-458b-a917-578253be72e4/72_indie-pixel-game-press-deck_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d737a3c-eb24-4ee5-aadc-2254a04a9b88/72_indie-pixel-game-press-deck_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9f4cc40e-e266-4163-9668-5a304a1e85df/72_indie-pixel-game-press-deck_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e54654a1-4136-490b-8d54-af4734e7c36d/72_indie-pixel-game-press-deck_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1cc59daa-eb30-4bdb-a0f5-4b2a8321c58c/72_indie-pixel-game-press-deck_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6b49c525-264b-4e18-a2b1-e9bf168c76b7/72_indie-pixel-game-press-deck_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/703ea32a-0343-4f72-a13b-6210d66e7cdf/72_indie-pixel-game-press-deck_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c0d6d78c-23c1-47cc-b9b4-bdcd5c8c21a0/72_indie-pixel-game-press-deck_08.jpg",
      ],
      designSystemId: "design-system:cosmic",
      templateId: "template:html-ppt-zhangzara-8-bit-orbit",
    },
    {
      slug: "indie-zine-release-party",
      title: "Indie Zine Release Party",
      prompt:
        "/gen presentation with design system `dithered` and template `html-ppt-zhangzara-retro-zine`, create an indie zine release-party deck for a local arts collective. Zine spreads, contributor bios, print run, distribution plan, launch night flow. Make it feel zine, tactile, retro.",
      embedUrl: "https://indie-zine-release-party-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/f9f431e4-2af6-4c1c-a9ba-d79e393fd7c0/92.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/850011ce-5f73-4a04-9f27-118d88aec5ce/73_indie-zine-release-party_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4d0c9fdc-e1e5-4030-8235-80fbaac9ea73/73_indie-zine-release-party_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/09c58e64-8dc5-4aa9-a3a0-56a96d643175/73_indie-zine-release-party_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/eb4d3e8a-1a2a-4625-9694-56275f8e963b/73_indie-zine-release-party_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8c7658c8-8958-4fae-983b-cc224b874056/73_indie-zine-release-party_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/76c57ae0-4b2d-4ed8-a99a-601b8a411a1a/73_indie-zine-release-party_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62c2752b-a6ec-41d5-8648-7003f7af442d/73_indie-zine-release-party_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0ba13236-f0dd-4d5d-9ce3-fad8dcc99bea/73_indie-zine-release-party_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cab18ee0-cb5f-4ecf-862a-77a3070a37f0/73_indie-zine-release-party_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62ec43df-e98b-4e6b-9325-d7edff1e32e3/73_indie-zine-release-party_10.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0d124a2b-78c7-4f6a-9ecc-8b8a72af10b6/73_indie-zine-release-party_11.jpg",
      ],
      designSystemId: "design-system:dithered",
      templateId: "template:html-ppt-zhangzara-retro-zine",
    },
    {
      slug: "fashion-house-autumn-lookbook",
      title: "Fashion House Autumn Lookbook",
      prompt:
        "/gen presentation with design system `dramatic` and template `html-ppt-zhangzara-pink-script`, create a fashion house autumn collection lookbook reveal. Mood manifesto, silhouette stories, fabric swatches, runway lineup, retail drop. Make it feel late-night, expressive, editorial.",
      embedUrl: "https://fashion-house-autumn-lookbook-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b12034b5-4a8c-4397-b77e-b1d4a464034f/93.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/02be5f93-aba8-4d33-b4fc-5074d8e80c40/74_fashion-house-autumn-lookbook_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c6876d01-9c96-4b57-bf8a-3d00defcb7fb/74_fashion-house-autumn-lookbook_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/79cae45a-abbc-41e6-90d3-da10671e65c9/74_fashion-house-autumn-lookbook_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6482d2af-870a-45b6-b419-ac412a3b7fea/74_fashion-house-autumn-lookbook_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/66f394a5-09ca-493f-8781-7c5d9bee0259/74_fashion-house-autumn-lookbook_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a2f1218a-3d73-43d3-8607-82853c870225/74_fashion-house-autumn-lookbook_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b025d2fd-6ef7-4189-8b54-ce07484a8793/74_fashion-house-autumn-lookbook_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bdc93901-2b26-4612-a7d6-7b4e4be30493/74_fashion-house-autumn-lookbook_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9ddf93b8-cad2-4a81-bf29-a9de48702054/74_fashion-house-autumn-lookbook_09.jpg",
      ],
      designSystemId: "design-system:dramatic",
      templateId: "template:html-ppt-zhangzara-pink-script",
    },
    {
      slug: "art-biennale-curator-pitch",
      title: "Art Biennale Curator Pitch",
      prompt:
        "/gen presentation with design system `expressive` and template `html-ppt-zhangzara-bold-poster`, create an art biennale curator concept pitch deck. Curatorial statement, artist lineup, venue map, public program, funding ask. Make it feel poster, editorial, bold.",
      embedUrl: "https://art-biennale-curator-pitch-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/868105dc-90ae-4e99-a045-0f22e7733a70/94.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1dfede44-f1a8-41a1-94f8-cb8be0ef6a80/75_art-biennale-curator-pitch_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/943bce5d-5970-4af8-beb6-42920489ad2c/75_art-biennale-curator-pitch_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a11d245e-0cf1-447d-85c1-6190fa5ed8b3/75_art-biennale-curator-pitch_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/66a85075-c9fb-4b50-9225-9c6cb2ac088f/75_art-biennale-curator-pitch_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f7188cc1-e5b4-47a7-bbb3-41c173d2b475/75_art-biennale-curator-pitch_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3eba3306-1400-4b38-8943-2dbcec5c8f84/75_art-biennale-curator-pitch_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b0855a09-934e-4396-bc03-b1f060dc962f/75_art-biennale-curator-pitch_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0541bac9-a510-4282-b49b-41fc0925d320/75_art-biennale-curator-pitch_08.jpg",
      ],
      designSystemId: "design-system:expressive",
      templateId: "template:html-ppt-zhangzara-bold-poster",
    },
    {
      slug: "grove-restoration-annual-report",
      title: "Grove Restoration Annual Report",
      prompt:
        "/gen presentation with design system `fantasy` and template `html-ppt-zhangzara-grove`, create a sustainability nonprofit grove-restoration annual report. Hectares restored, species returned, community stories, donor wall, next-year goals. Make it feel forest, hopeful, refined.",
      embedUrl: "https://grove-restoration-annual-report-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/78e6570a-5936-4f93-a038-c83f885c6f33/95.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1476529a-68af-4f24-812d-4efe62b49ccf/76_grove-restoration-annual-report_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8dddd732-d04d-4194-91c9-126143054861/76_grove-restoration-annual-report_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ef216388-f2d1-4512-8d39-549be15e2ba8/76_grove-restoration-annual-report_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cf0ef043-2b10-4274-a0ec-a53b67fa4f1c/76_grove-restoration-annual-report_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e937aafb-ac36-4908-8d15-1f0571ac5712/76_grove-restoration-annual-report_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/64e49e15-b6de-4ba0-a540-1d47e40e8d5b/76_grove-restoration-annual-report_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/033f225c-fe59-479f-a44f-bd908985b294/76_grove-restoration-annual-report_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2a5df8b0-e183-4880-b662-a5059e922e1c/76_grove-restoration-annual-report_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e5de4c27-2777-45e8-befb-d6d1f7a70276/76_grove-restoration-annual-report_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e37740bf-688e-4f37-b22a-b5ada6768443/76_grove-restoration-annual-report_10.jpg",
      ],
      designSystemId: "design-system:fantasy",
      templateId: "template:html-ppt-zhangzara-grove",
    },
    {
      slug: "antique-paper-restoration-catalogue",
      title: "Antique Paper Restoration Catalogue",
      prompt:
        "/gen presentation with design system `kami` and template `kami-deck`, create an antique paper restoration studio exhibit catalogue. Featured works, technique notes, restorer profiles, sponsor wall, event calendar. Make it feel parchment, considered, craft.",
      embedUrl:
        "https://antique-paper-restoration-catalogue-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/245ae8d0-d9b5-4d50-b2d5-6f88220d0ce2/96.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7d8954a4-406e-4f64-922b-d0f9979a6d39/77_antique-paper-restoration-catalogue_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/40c34b98-7eed-4fcb-a1c8-2f05ccd0fe06/77_antique-paper-restoration-catalogue_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ca121721-e83f-4420-a0a2-57f91a588937/77_antique-paper-restoration-catalogue_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7ca4e8b5-b1e5-4165-ad3d-fef5a92d2832/77_antique-paper-restoration-catalogue_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/825c3b72-cf97-4c3d-b9b0-f4d980166267/77_antique-paper-restoration-catalogue_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a162baf4-b6e4-42ee-930b-c75c15ab7651/77_antique-paper-restoration-catalogue_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fadb5178-fae7-446c-9f68-3e62e53843cc/77_antique-paper-restoration-catalogue_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d48a80b0-63b2-4765-80d2-be89c7ed5369/77_antique-paper-restoration-catalogue_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/50b431fe-a6be-4425-8cea-cdb9ecad0b17/77_antique-paper-restoration-catalogue_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9791c905-0d7a-4a7d-804d-515347e04e90/77_antique-paper-restoration-catalogue_10.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/31a65df7-7773-4b1d-8a9d-47538ee3193d/77_antique-paper-restoration-catalogue_11.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fc87ab5b-1fb0-4f24-a461-bbb452c6127a/77_antique-paper-restoration-catalogue_12.jpg",
      ],
      designSystemId: "design-system:kami",
      templateId: "template:kami-deck",
    },
    {
      slug: "community-zine-workshop-facilitator",
      title: "Community Zine Workshop Facilitator",
      prompt:
        "/gen presentation with design system `paper` and template `html-ppt-zhangzara-pin-and-paper`, create a community zine workshop facilitator deck. Workshop arc, supply list, sample spreads, peer feedback flow, takeaway zine. Make it feel handwritten, friendly, paper.",
      embedUrl:
        "https://community-zine-workshop-facilitator-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/b6992a13-7ff4-4a7a-97ec-438fe51e958a/98.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9fb01b30-f88d-49ce-bc5e-ff8f2cdc547e/78_community-zine-workshop-facilitator_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2b5ed070-1038-4487-9f6e-6430e0cc484f/78_community-zine-workshop-facilitator_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/953a418c-6166-4e89-8c77-7f2ba6fc6ade/78_community-zine-workshop-facilitator_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b15cf834-a663-40ba-bc00-57673207fa3b/78_community-zine-workshop-facilitator_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb39a6ee-0adf-40fd-827e-2da310a56160/78_community-zine-workshop-facilitator_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a52014af-a0c3-4382-a9c7-d33a790aa0fd/78_community-zine-workshop-facilitator_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/02b6618b-68d3-4e21-97c8-e87ce0561012/78_community-zine-workshop-facilitator_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e863df24-5733-4877-94c2-639b836dc10a/78_community-zine-workshop-facilitator_08.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f55e4f26-0d72-4a2d-8bd4-fba1da7ba617/78_community-zine-workshop-facilitator_09.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3c3e8824-8d27-4e9b-8b54-f976be320aca/78_community-zine-workshop-facilitator_10.jpg",
      ],
      designSystemId: "design-system:paper",
      templateId: "template:html-ppt-zhangzara-pin-and-paper",
    },
    {
      slug: "90s-tech-nostalgia-lightning",
      title: "90S Tech Nostalgia Lightning",
      prompt:
        "/gen presentation with design system `retro` and template `html-ppt-zhangzara-retro-windows`, create a 90s tech-nostalgia conference lightning talk. Boot-screen tour, software archaeology, AOL anecdotes, demo screenshots, audience Q&A. Make it feel pixel, retro, playful.",
      embedUrl: "https://90s-tech-nostalgia-lightning-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/67585023-4897-43e6-90c4-690c42cbc309/99.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e5e7e060-770f-4b2e-abc0-4fe20e6f85f5/79_90s-tech-nostalgia-lightning_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7af71d1f-2378-461c-888d-3bbd6889ec40/79_90s-tech-nostalgia-lightning_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d0a3387e-339b-426a-9e2e-e7e69c736791/79_90s-tech-nostalgia-lightning_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/46e6db01-661a-4268-8094-b25dad9d28aa/79_90s-tech-nostalgia-lightning_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5af0a5f1-2188-4e77-995d-78c59ff1d10f/79_90s-tech-nostalgia-lightning_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f7157676-7df5-4690-bbf4-5ea3e7d565d3/79_90s-tech-nostalgia-lightning_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1deadc88-78f4-49b6-96e5-a0014ab66244/79_90s-tech-nostalgia-lightning_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dc6442dd-1b27-45fa-a572-e0b2cafc59fe/79_90s-tech-nostalgia-lightning_08.jpg",
      ],
      designSystemId: "design-system:retro",
      templateId: "template:html-ppt-zhangzara-retro-windows",
    },
    {
      slug: "ps6-dev-summit-roadmap",
      title: "PS6 Dev Summit Roadmap",
      prompt:
        "/gen presentation with design system `playstation` and template `html-ppt-zhangzara-8-bit-orbit`, create a PS6 dev-summit roadmap deck for studio partners. Console specs, dev-kit timeline, marquee titles, store policy updates, partner programs. Make it feel arcade, neon, gaming.",
      embedUrl: "https://ps6-dev-summit-roadmap-715f6d07.sites.vm0.io",
      previewImage:
        "https://cdn.vm0.io/artifacts/user_35iyIuFrcCRvYzXGomnWn44jBoo/caabca48-9d75-4865-a071-67d1cea65fc0/100.jpg",
      previewImages: [
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e6e47858-5c0d-43bd-8450-7b8ce4568bf9/80_ps6-dev-summit-roadmap_01.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/04388bfe-d2a7-4bdc-b102-c49c48842e21/80_ps6-dev-summit-roadmap_02.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/381108bc-9655-4bcd-a45f-14921b245a98/80_ps6-dev-summit-roadmap_03.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fe6d994d-f9fc-440a-b8be-12f30bb90c95/80_ps6-dev-summit-roadmap_04.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/39ad1b5d-9b3b-40e3-8465-b29a9cb5a2bd/80_ps6-dev-summit-roadmap_05.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e818ab8c-24f8-414e-b9b8-90f8d2b276f7/80_ps6-dev-summit-roadmap_06.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/93541968-721e-4914-b470-3b4fb20ab3f3/80_ps6-dev-summit-roadmap_07.jpg",
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9ccc8547-ad70-44ea-b28d-6dfcf56cf148/80_ps6-dev-summit-roadmap_08.jpg",
      ],
      designSystemId: "design-system:playstation",
      templateId: "template:html-ppt-zhangzara-8-bit-orbit",
    },
  ];

const PLAYFUL_LAUNCH_CDN_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/774bdd46-ca62-40b5-b56b-95fd2ff2d302/playful-launch-presentation.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dbb11b25-20e0-433e-94d5-9a094667d5a7/aplocoto-slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d6a0800b-729e-4399-ba74-e3d56b4e9b00/aplocoto-slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/67781114-f6ff-45fd-bb74-bf65df1b75e9/aplocoto-slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9860a2f5-512a-4f0c-a215-33ad6153ee66/aplocoto-slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7c884040-00c0-4237-8560-44a78c9bc9df/aplocoto-slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/90905547-8551-46ee-91fe-cdf364a0a415/aplocoto-slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/13260433-b222-4561-a62f-273f2c275f4c/aplocoto-slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f88b5182-4312-49a7-bd1c-3814405d5205/aplocoto-slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/060dafd9-d147-4a42-89dc-4b22fa92e880/aplocoto-slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d104d1c5-c038-40b0-b7e2-078a9f93c062/aplocoto-slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d51c10d0-fdba-41b3-b88f-1d4e118c7368/aplocoto-slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7e3ca86-846e-44f9-8eb0-637699168192/aplocoto-slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ecc39ab1-0a68-4da5-9cf4-20b1e0b2eeb0/aplocoto-slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f403f161-f63c-427f-ae15-401ede2672d9/aplocoto-slide-15.png",
] as const satisfies readonly [string, ...string[]];

const BUSINESS_DATA_CDN_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9aa42296-a49e-4128-a80a-e920637b1506/business-data-presentation.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/04a3765b-ef6a-4bbb-8ae4-b116941760cf/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1919e6e0-2adf-4727-825d-3470568733e7/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62d71bc2-9359-4a41-bde6-da6e4d9d0fd0/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d587627-8f20-4aed-ad2b-0593f58c22d9/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b16f1790-05be-4a49-85cd-3417c51376c9/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/de3b1bca-c6bf-4f45-ba6e-898ebb51c8ca/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f1fdaf81-3914-4882-89c1-eb2da901dfd8/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/982833de-dd95-4560-81b5-8b006d7fe3c7/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/15fbcdfa-fc5c-48a8-aa4b-4ea88550b1e2/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4a29b39a-97d0-4c26-892a-85e808f0a21f/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/056c9f76-3ee0-4990-a445-72044cc84a66/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a1a1fc29-4682-484e-b5eb-2e09c5b0c8d3/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7817bac4-9ecd-4e00-a532-d6ba2816c322/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/37616a8a-7386-49f2-8e18-198a2a234d4a/slide-15.png",
] as const satisfies readonly [string, ...string[]];

// Batch presentation resources migrated from Google Drive to private R2.
const CRAYON_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c4d3f251-c143-4cb7-86f5-97042123ef90/crayon-learning-deck.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8183eea0-8016-4680-82b8-8ad3a3b5ada2/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/356c7e99-4895-44e1-a56d-d53dfb0d722e/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f81f04ee-f164-4d0b-abd2-1bec62637036/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2aace698-e937-4c5c-83b7-43b4ea6aa193/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/db411e40-59c5-4428-b2fd-dc71846bbf32/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4cea2af8-cd7b-4446-a895-03e151591e9a/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1e500a83-2644-49b6-a7a7-dabb10025344/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a6c157ad-644f-4dd8-be84-c04ad53e8eba/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/abadaabc-a366-40b7-8cad-17e302e24cea/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/810651dd-7c4e-4115-a9b4-8eb4e804e669/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/52fac853-0a29-4215-951d-2d9780720119/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/32876cfe-2e5e-4807-b308-06a9b617ac36/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6db8270e-31fb-4df6-9d8f-495dced6c2ed/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d82049a8-dbb6-4425-9043-058720a335a6/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const CRAYON_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/351717b6-5c48-42c5-a349-d8a815bc229f/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c4116423-38ef-48d9-9728-695bf265e510/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2cb2711a-0638-4673-a47b-69a51116e21d/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/32f3a867-b29d-4b0e-ba32-073167892556/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7e49363-33ae-48c6-998a-f911e51bf340/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0c005465-e491-4d84-915c-efc892bf6030/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3baf78ed-8cec-4da1-9734-3a8ca51a1d6c/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/803373ba-fa20-4ebd-84ad-cb73f4e10dcd/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/27ef439c-3dc2-49d2-b5ca-de98d20f2ca6/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c498a285-2d3f-4c76-9ebb-d26ad42f677c/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b79a2ac4-ef78-4a3c-b47e-6f1310756b7c/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e8dac0bc-f2a2-440c-ade3-c979d34b7459/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3f6c4cae-cac2-4cf1-93d8-d2d4609cad8e/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0742c906-1dcb-4bec-80e3-f0e5387e727d/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d13fd530-4917-4378-8e2b-8c0befd96119/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const CREATIVE_AGENCY_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6494f661-c935-4ab2-9181-600097bde23b/creative-agency-presentation.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a1883f03-854f-4f31-9da5-5d1f80179ea9/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/261165ff-ded6-4662-9b1a-62df42b234b0/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a2e4e44e-1a6d-491f-903c-4e2188023d3c/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/39871f71-1392-4911-8771-f22b715d7a9e/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f8b8651e-de6b-4adb-a733-c92dc0f859e6/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1d3342e3-e91f-48df-8302-1931423f7de6/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/70e13d5b-d9df-4e39-a257-ded24b0fd2f8/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8280b48a-4c05-4022-ae9c-8b5073562b53/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/efe70b44-2eaf-4094-8404-a2238e101d42/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6bc29f83-9a2f-4f9a-bf63-b7d30acc6941/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c6ca5fe0-1def-4eb2-a5fe-2e31fc60dac7/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7557bbcc-8502-43eb-8d91-fa2b8035e15d/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/07fa40fd-5c73-4913-9ed2-a248e3e56865/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62403bf8-6aac-40af-b279-95239dc20139/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const CREATIVE_AGENCY_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/440dde23-496f-4e4c-9b78-226deda76c4c/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/80de0f45-96af-4131-8cc8-9f6a058efe96/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5acb529d-e17a-4b7b-b418-1dc49f50bc53/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ebc56020-ec50-4125-8467-f6361648687b/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/20d61d5a-a7d2-4cf5-a7ba-2d507e8df1d8/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8a89a5f5-af1c-4b64-941d-59fd55904c43/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/152b7fb4-5619-4344-a714-0a29434f082c/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/aa8de55e-a778-4a24-b530-9c76bcb85991/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/afe9346a-de0f-4141-9434-e5bda6f09efe/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/995f23c4-bda7-4f8c-80bb-cd5e4eda3f57/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/de3d07df-083a-4218-8c86-fcff79251a47/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a21f6ee8-f967-4415-9825-27c08a28cc09/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f25909ac-88d6-48eb-859c-488d5bbacd9f/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1bea8f97-d0e5-4240-bae5-c3bbe5cd5ba2/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/188bdf52-0a5b-466a-8417-b8920e35fb5a/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const DATA_REPORT_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/26958aa5-8823-484f-8bce-6f60a8663a72/data-report-presentation.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/efa3e160-e608-4658-9395-9a4139899038/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/edd27584-ef9f-4611-b8ab-59e3ac7247ad/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a505694f-8511-45bb-94bd-0095b75e6028/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/77cb14b3-aec9-4694-9a12-880eb0a11fc6/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/02dffc66-0883-45bc-9567-a063368619b5/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c11f15e4-e164-4803-9d39-9b787e1b35c5/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6c426018-8ec4-43c6-8998-4b1ae1aff6d1/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/19fceff3-2317-4e84-9918-600a66bf375a/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/401c3f73-810b-4ebc-a448-7d9bd5ecc882/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8b97bb9b-667a-4596-bbf6-fba2c55eca5f/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dc80199e-4b44-4602-8b4b-6af9d65f1845/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/95a0c217-421f-4a57-97db-700b076eed1a/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8e7c176a-7997-4b5d-9773-68cf0b307c8e/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a0269c99-9d1b-44e2-b49a-0980820b3b90/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const DATA_REPORT_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/16310322-2d80-4142-a5f5-7bcff8c3eed0/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be665757-c3d0-4091-b957-9b2090d6523d/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/38b3ce82-7212-44d1-a5ae-a9477ce5e086/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/90d4ca26-8f11-413d-a9d5-611c3dfb7971/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b08266e5-92fe-45c8-82bd-a02a1921e780/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e958c1d0-9674-4149-94e5-23a6b78b7151/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/99d8ebd7-fdc7-427a-a000-a24675b1a730/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/04fc9197-1543-487c-82eb-0560cde0c17d/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f979bae9-63ad-49fb-81f1-f4149e244fe0/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/eb896ae1-adf1-4681-948d-564c73a6ac82/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/479c66d1-7999-43ef-a24c-e18399053105/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5e9763c0-7dfb-495c-af1d-9cf25bcfcb4c/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a9f6fc70-1099-461a-be6b-a4bbabce5f4a/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/be6017d7-be11-436c-b67a-050ebee5fdb7/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/41099f41-7548-4a11-beb5-cebde83df691/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const EDITORIAL_MAGAZINE_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/adf552b2-53ed-4282-b08c-2359f3b124ff/editorial-magazine-deck.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/63b4c9a6-7f1a-4f49-af9b-dd93d9d9138a/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b7dc0361-f59a-4fdb-b350-f18bc99a422e/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4718eb4d-7672-4194-9710-f980a5e9d4a1/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/26bc2e44-8975-48d2-a659-0364f148c835/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3b3e8dab-8f75-4773-a467-043e5525b491/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/646d057e-f8d8-48e1-862e-db4095c2af28/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/506d1159-c15f-4b63-ad09-3ab538036099/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9618e2b2-425e-43c3-9399-6c89ea8ab458/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5008900e-ebc8-4355-b07e-995624af5a52/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0a84ce72-1816-4f5e-8e17-9d9ed3f7d7a4/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e80c360-a1ef-45d4-a0f2-fd18c1ce8f2a/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/172f784b-3502-485f-9ab4-e4714afa7b22/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2897a88f-0b4c-4892-bb32-eb4545cc3acc/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c453a78d-8109-423b-ae0e-278123d38239/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const EDITORIAL_MAGAZINE_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/539b64b7-ba42-4f62-a54f-1427b2afddb3/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b1a544b4-a4a1-4292-ba63-61843a14c5b3/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d4880c62-7c63-4696-b80a-2bed0108a988/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/84ddea62-a1eb-425f-8b09-450f104aa3a5/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/02425e87-5b9f-4680-bc3d-2c58c7d2adc1/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/85d7e4f9-31bc-4ba8-9b21-11be2342d135/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/58c58583-41fb-4d78-be75-1c905a8776f1/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/15c39a3c-05e0-41e5-b5b8-71ae03377232/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a9decabb-f920-46b6-a5f9-a5ec3d12b962/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62965071-8c8d-4b14-970c-3e7903c85195/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8d81c8d4-c1d4-49e1-b9cf-60ee42b1c225/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1539da62-2481-4dfc-8b5b-5ca6118bc1f3/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/326ebe33-8072-4a14-af18-70ec77f59360/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b45db466-6e73-418e-9e65-f86a3c17be8b/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/512d2421-0d60-44ed-81b1-29620a93ed5c/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const LANDING_CONSULTING_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb94c9f1-8ab7-46cc-a08a-693e40337f06/landing-consulting-deck.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ca96e383-1431-466c-8c3e-9fc13a91d2c5/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5a8a9671-68bd-4d07-9fb5-078bdb0199a6/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/710c14c7-3dc6-4b10-b8d8-27fc4df2a0b0/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0eda445b-ed1d-4922-8a9e-ae8e39ff06e8/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e9e61546-3e5d-4307-ad97-7b5ddf92a960/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8646d1e2-4d3c-43c4-970a-df36476eec9c/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8dada9ca-9908-42c9-a010-ce42e431f108/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/73fc1ea3-e10b-4151-b0fe-e2cdf4ec7e4c/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/39f3b5b2-5cc9-409b-affd-f861460f1b8c/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3f241aa1-5cad-4030-a00b-cb6402390704/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a79c9f31-d9cd-40c3-8cca-907599ee2a9a/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/622ee524-2f19-44a0-9613-26036f4474e4/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e38718d5-1059-4df4-a322-e9d73369c57e/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a5f1fff4-18f9-4eaa-860c-c9ce8b57922d/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const LANDING_CONSULTING_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b02b4e7a-861d-4db3-af6f-a6e1f492a805/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/512dda48-57e2-4264-aba7-21500b56e38c/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a15f57d1-fbad-4a2a-ae3b-e02f97eef373/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/45047a7b-242c-4cda-a8d1-98471d8bd8e7/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a138a120-8d27-4bfe-8e9b-2dee7e8398ad/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8a2d4e51-7515-442b-9ff6-8ea1d74cbaed/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a0d46684-2831-4653-80af-34e0e6492da7/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c43fff61-c6a6-4524-a222-9ccbfb25e82e/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7016072-aada-44f8-93cf-15c2cf0bbcf9/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f4b22edf-cf10-4f7c-acbe-fbe5dab95f08/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/100de24b-6e80-40c7-864c-2dece1e3fcef/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/135a102e-1f28-4fc3-8d26-f57bc93ce1f9/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d5e42744-3bbc-4e85-9f6a-dae697986214/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4507a7cb-ac95-4363-96bb-03def14afbe3/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9b54f283-b5de-4d49-a525-d3ad1b2304e8/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const LUMINA_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a9c9d0c7-726c-4013-802d-cde1feefd058/lumina-creative-studio.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/592fe965-5a74-4366-b8b9-e58605dcc16e/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb9df939-ec5a-4949-980d-7300eee0def4/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dc1afd19-e772-4e27-baa0-5b0790b7b056/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/abfe04fb-2f9e-42bd-b7da-9613676dee09/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/71b059b8-e4b3-4aea-9210-10c0f321f827/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c91c081d-70a1-4a73-b7f9-2f2cce4c309f/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/065462c6-ed5f-499a-adb8-fec17c468cb7/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9733dd6f-9aa3-440b-88c4-cfcb61676035/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7dbb64c1-0a07-4b36-b96f-b1a460503f68/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/06a117bf-ca82-4a80-a282-3836a8079994/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ddbcb419-6eba-41d6-aa30-0677352a042c/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/40783c03-36a1-40a7-91e4-f974d9aa8a58/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8a7c8c68-12e8-4500-ae37-5b7db7d782c7/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a913f8f3-3aa4-47d6-b29b-fe39de18ebaa/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const LUMINA_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/77b00b14-0909-4e10-afea-3c39ae74db73/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/01faf670-8355-43f4-bd87-a283eff2500b/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/1721d052-b4d9-4c8e-be68-b9d433dcc504/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/995dc4b4-929d-4788-9f42-6da9e37c7ffd/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c20a8bfb-4b85-4407-abc7-ac8b5e04f13d/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4c6d6b98-8f11-4afe-8d44-1d07f0fc52f6/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2f236399-80f4-48d9-aa92-9f5c4fb2d161/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e02a7dc9-1fe7-454b-82ea-5968d10d5d73/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5373c442-9cb4-4245-99c0-270fe449880c/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e3234608-ff95-4de6-84b4-50f077062609/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7779e5ca-9759-470c-abe2-3d9aa7e68e5c/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9e45d5c9-9b2d-4b28-95ad-965a8566d48b/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/009219ba-4047-4e84-87d7-9d1295728751/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/da94d8b8-375e-413f-91c0-8b84f631744e/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5c3ad467-780a-4a59-b95c-26379e13e598/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const MOSAIC_GEOMETRIC_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0491adb1-f2a3-47d3-8075-509e036e913d/mosaic-geometric-pitch.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/22fd98ad-7ca0-4b08-8e9e-383da4ccbb49/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a04cac03-384e-4e05-95a2-d345e95e1141/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5e3518b8-5077-467a-a2d5-612f754c8535/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cdbb1d16-dd0f-46a4-b43e-0963a4f2e7c3/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0c2632ed-2313-4286-9921-aa39e9472371/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cd4b3cbe-5287-4a8a-ae18-107f3bfd2419/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/279d368b-4772-460f-9fe6-aea782745e70/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/92acc27f-60fe-42e7-8960-8c95b3921986/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dd46a4b5-cff3-42a5-b39a-0add674c20c0/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0eca7af8-e188-4001-88d3-99b47fd49c2b/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c29e6151-c5c1-401a-9263-2949209e2a70/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f7132349-afea-44aa-8294-ca0e35a44210/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/847e4eb8-6f15-4b18-9133-eb48da0a0e30/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5355056e-e86d-4a65-afa3-9e3be0d05a32/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const MOSAIC_GEOMETRIC_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/58a4dec5-db7a-4e03-835e-e49637dba964/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/62d75fe7-4224-4943-a765-f558ab426bce/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b4482261-179a-4ca0-8a00-0186a51fcc1c/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/af249477-c261-41cd-86d4-8e1aba376a32/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e7f1da55-2c8c-4858-aa13-33ab42d216ba/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/2992c1ee-84db-4ab5-b251-a317a160de66/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/35e0c6f8-f96e-4c67-8375-62ce1c47178f/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/61a88e05-442b-4b25-9488-2f5e2df4dcf8/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/140aac80-54d7-46bb-af05-40121cc85f0a/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/60b1ad5d-631b-42fc-8b29-bedf3b4e2a6c/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3c3fd19a-8087-4177-bdd9-e7dde6109a2f/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0cc9cb46-0019-4d45-a33d-5fff36c2a754/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/29123d43-c90a-48e4-9d1d-f1657f396a34/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/23284bc3-078b-4cd2-a3e2-f207605e6ad1/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ac616f61-f1bc-44af-8862-c219f7f74bfe/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const PLAYFUL_POP_PREVIEW_IMAGES = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3b6e8fbf-15f4-46cc-a2a6-8d3ef33d9d32/playful-pop-deck.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/083b8e2c-ea0a-434b-93c9-69d129ed242c/slide-02.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/9d957db7-4449-4fe9-8adb-6eff201b0fcc/slide-03.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/25afe786-d2c6-4d49-acbc-d8c60fce5fb4/slide-04.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b2c5cf99-65ec-49f1-861e-0a80905ae5e5/slide-05.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/e6a1d840-de51-4aec-a773-e3e8abe1ec1e/slide-06.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dd4589bb-563e-44cf-bc26-f11b7db3a20c/slide-07.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/8a34076e-f629-4da3-a25b-68cf705cc788/slide-08.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/06757c76-66fb-4b6d-ac26-a6e0b50f9cd5/slide-09.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/60f90bbb-bdb0-4f17-9258-4e52e8e41d91/slide-10.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/17941998-dab8-48ee-bda2-f6d6a502ff98/slide-11.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/7cbb4445-e1ae-4876-8ac8-39d8bbb79df3/slide-12.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/82b45a46-b5f3-4a97-a480-e07cadac0a96/slide-13.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/85672b12-bd99-4748-9b56-ec39aae695f5/slide-14.png",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/805bd601-9e99-40b1-a66a-34251c70c787/slide-15.png",
] as const satisfies readonly [string, ...string[]];

const PLAYFUL_POP_PREVIEW_HTMLS = [
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/098f0ce4-c773-4479-ad85-221c9114881a/slide-01.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/009db4d7-19f9-4266-a08d-2eb827678fde/slide-02.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a143dba3-9e72-44c5-a105-0e5228125a1c/slide-03.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b541db0e-322e-4604-9b13-ff117b5fcf7f/slide-04.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/3fa2f420-248a-4679-b76e-fb620fd67868/slide-05.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/859a88eb-5f9c-469b-b6c7-5987fe9e92f0/slide-06.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/23b1ec6d-ba39-41a6-923f-7c125c530f08/slide-07.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b469c7a6-5151-488d-a59f-e38e091e376d/slide-08.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/46c96f07-8232-44fd-932e-e0a6e6abc0a0/slide-09.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/465fb0cb-18ff-4284-a184-d6a7cc8aa49c/slide-10.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a72c8c6c-c5d5-4fac-95bd-f299102d344e/slide-11.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/27203fae-eb0e-49eb-8077-e69f7a888382/slide-12.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/bde44218-8dfd-418e-863a-f6e99808b2b3/slide-13.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f84b61fc-4775-4ee3-ab28-fa9762b602fe/slide-14.html",
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c3eaf388-6b9f-49b6-90af-ce27eedb87e2/slide-15.html",
] as const satisfies readonly [string, ...string[]];

const PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES = {
  "bloom-pitch": [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4124c01a-a6c7-484c-9e22-8dd4d62a6c6c/bloom-pitch.png",
  ],
  "blueprint-academy": [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ffa9f511-0e01-4191-99a6-3d6621b99661/blueprint-academy.png",
  ],
  meridian: [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/189d2344-ca5f-4dbf-86ce-04b1567c062f/meridian.png",
  ],
  "neo-brutalism": [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/a184e26a-c514-434e-9467-a19b2af1e979/neo-brutalism.png",
  ],
  nocturne: [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fb660157-e71e-4064-8a96-0c707c7e6a1f/nocturne.png",
  ],
  "pixel-glitch": [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dfcbf20f-9341-4f3f-a93d-4df159f6c4fd/pixel-glitch.png",
  ],
  prospectus: [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/5aad7d6c-4ca1-4041-985c-27674403c382/prospectus.png",
  ],
  schoolhouse: [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/b8cdd8b6-122d-461a-8dc4-d17a73ad09e5/schoolhouse.png",
  ],
  "sticker-scrapbook": [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4a6c9374-be17-40f9-83e9-acd7d6461efc/sticker-scrapbook.png",
  ],
  strata: [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f931d6b1-c44e-442a-bcd4-c23f60888a7d/strata.png",
  ],
  "taped-consulting": [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/fbf6d3b5-9a96-46a4-9fe6-6874b1bb5b63/taped-consulting.png",
  ],
  vantage: [
    "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6d1aea99-3215-41b6-9994-6a4613d64524/vantage.png",
  ],
} as const satisfies Readonly<Record<string, readonly [string, ...string[]]>>;

export const PRESENTATION_TEMPLATE_PICKER_ITEMS: readonly PresentationTemplateItem[] =
  [
    {
      slug: "playful-launch-presentation",
      title: "Playful launch",
      prompt:
        "/gen presentation with design system `playful-editorial` and template `html-ppt-playful-launch`, create a 15-slide launch deck for SproutPop, a playful habit-building app for remote teams introducing a shared 30-day wellness challenge. Present it to people and culture leaders with cover, agenda, launch story, audience pain points, product vision, feature tour, rollout timeline, activation moments, team, early metrics, testimonials, pricing, and next steps. Make it saturated, joyful, idea-led, and structured.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/daf7c2d1-5195-4c09-ad4b-8d85778fc104/playful-launch-presentation.html",
      previewImage: PLAYFUL_LAUNCH_CDN_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "playful-launch-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "playful-launch-presentation"
        ]["carnival"],
      previewImages: PLAYFUL_LAUNCH_CDN_PREVIEW_IMAGES,
      slideCount: 15,
      colorSystemId: "color-system:carnival",
      designSystemId: "design-system:playful-editorial",
      templateId: "template:html-ppt-playful-launch",
    },
    {
      slug: "botane-organic-deck",
      title: "Botane organic",
      prompt:
        "/gen presentation with design system `botane-organic` and template `html-ppt-botane-organic`, create a 15-slide brand story deck for Moss & Moon, a coastal wellness retreat launching a seasonal herb garden, tea bar, and slow-living membership program. Present it to hospitality partners with cover, agenda, origin story, guest philosophy, retreat spaces, treatment menu, garden-to-table process, photography gallery, sustainability metrics, member testimonials, packages, and contact. Make it calm, editorial, rounded, and organic.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/0babab92-7ad9-414e-b44f-7a060ed48bcc/botane-organic-deck.html",
      previewImage: BOTANE_ORGANIC_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["botane-organic-deck"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["botane-organic-deck"][
          "mauve-dusk"
        ],
      previewImages: BOTANE_ORGANIC_PREVIEW_IMAGES,
      slideCount: 15,
      colorSystemId: "color-system:mauve-dusk",
      designSystemId: "design-system:botane-organic",
      templateId: "template:html-ppt-botane-organic",
    },
    {
      slug: "business-data-presentation",
      title: "Business data",
      prompt:
        "/gen presentation with design system `business-data` and template `html-ppt-business-data`, create a 15-slide executive data readout for HarborCart, an omnichannel grocery retailer reviewing 2026 growth, loyalty behavior, basket mix, and store-to-delivery conversion. Present it to the leadership team with cover, agenda, business context, KPI scorecard, regional segments, channel comparison, customer cohorts, operational drivers, forecast, strategic bets, risks, recommendations, and appendix contact. Make it number-first, chart-led, confident, modern, and readable.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/95648bba-2a52-497e-b1b8-9cdd0cab9d93/business-data-presentation.html",
      previewImage: BUSINESS_DATA_CDN_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "business-data-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "business-data-presentation"
        ]["berry-pop"],
      previewImages: BUSINESS_DATA_CDN_PREVIEW_IMAGES,
      slideCount: 15,
      colorSystemId: "color-system:berry-pop",
      designSystemId: "design-system:business-data",
      templateId: "template:html-ppt-business-data",
    },
    {
      slug: "crayon-learning-deck",
      title: "Crayon learning",
      prompt:
        "/gen presentation with design system `crayon` and template `html-ppt-crayon`, create a 15-slide parent-night deck for Rainbow Lab, a summer art-and-science camp where kids build storybooks, cardboard cities, and tiny robots. Present it to families with cover, agenda, camp promise, learning goals, weekly themes, instructor team, sample day, workshop stations, student gallery, safety plan, progress metrics, parent quotes, pricing, and registration steps. Make it bright, rounded, joyful, and crayon-like.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/63af1d38-51e8-493e-b975-1728f4f796da/crayon-learning-deck.html",
      previewImage: CRAYON_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "crayon-learning-deck"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "crayon-learning-deck"
        ]["prism"],
      previewImages: CRAYON_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: CRAYON_PREVIEW_HTMLS,
      colorSystemId: "color-system:prism",
      designSystemId: "design-system:crayon",
      templateId: "template:html-ppt-crayon",
    },
    {
      slug: "creative-agency-presentation",
      title: "Creative agency",
      prompt:
        "/gen presentation with design system `creative-agency` and template `html-ppt-creative-agency`, create a 15-slide rebrand pitch for Northstar Studio proposing a new identity, website, and launch campaign for a boutique hotel group expanding into three coastal cities. Present it to the client board with cover, agenda, brand challenge, strategic insight, creative direction, visual territories, service scope, project process, case-study gallery, launch roadmap, impact metrics, client quotes, investment, and contact. Make it minimal, editorial, sharp, and agency-grade.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/527ad859-e0dd-4cfd-90a4-09e5030b71e1/creative-agency-presentation.html",
      previewImage: CREATIVE_AGENCY_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "creative-agency-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "creative-agency-presentation"
        ]["coral-studio"],
      previewImages: CREATIVE_AGENCY_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: CREATIVE_AGENCY_PREVIEW_HTMLS,
      colorSystemId: "color-system:coral-studio",
      designSystemId: "design-system:creative-agency",
      templateId: "template:html-ppt-creative-agency",
    },
    {
      slug: "data-report-presentation",
      title: "Data report",
      prompt:
        "/gen presentation with design system `data-report` and template `html-ppt-data-report`, create a 15-slide research findings deck for MetroPulse, a city mobility study comparing bike-share, buses, rideshare, and commuter rail across 12 neighborhoods. Present it to urban planning stakeholders with cover, contents, study context, methodology, demand trends, neighborhood segments, mode comparison, peak-hour bottlenecks, equity impact, emissions estimate, 12-month forecast, recommendations, summary, and contact. Make it chart-led, sharp, vivid, and number-first.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/920c6119-1833-4902-bda9-327af1bd8f7f/data-report-presentation.html",
      previewImage: DATA_REPORT_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "data-report-presentation"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "data-report-presentation"
        ]["prism"],
      previewImages: DATA_REPORT_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: DATA_REPORT_PREVIEW_HTMLS,
      colorSystemId: "color-system:prism",
      designSystemId: "design-system:data-report",
      templateId: "template:html-ppt-data-report",
    },
    {
      slug: "editorial-magazine-deck",
      title: "Editorial magazine",
      prompt:
        "/gen presentation with design system `editorial-magazine` and template `html-ppt-editorial-magazine`, create a 15-slide media kit for Field Notes Quarterly, an independent culture magazine pitching its autumn issue on craft, travel, food, and design to premium sponsors. Include cover, editor letter, issue theme, audience profile, editorial departments, contributor roster, feature previews, photography gallery, distribution plan, partnership formats, audience metrics, sponsor examples, rate card, production timeline, and contact. Make it restrained, paper-forward, serif, and magazine-like.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/85360bd6-8b80-43ba-9c9c-001b7d96f205/editorial-magazine-deck.html",
      previewImage: EDITORIAL_MAGAZINE_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "editorial-magazine-deck"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "editorial-magazine-deck"
        ]["warm-sand"],
      previewImages: EDITORIAL_MAGAZINE_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: EDITORIAL_MAGAZINE_PREVIEW_HTMLS,
      colorSystemId: "color-system:warm-sand",
      designSystemId: "design-system:editorial-magazine",
      templateId: "template:html-ppt-editorial-magazine",
    },
    {
      slug: "landing-consulting-deck",
      title: "Landing consulting",
      prompt:
        "/gen presentation with design system `landing-consulting` and template `html-ppt-landing-consulting`, create a 15-slide growth proposal for ScaleBridge advising a B2B fintech SaaS team on reducing onboarding drop-off and improving trial-to-paid conversion. Present it to the revenue leadership team with cover, agenda, opportunity size, diagnosis, desired outcomes, engagement model, workstreams, sprint process, benchmark gallery, proof metrics, client testimonials, pricing tiers, decision timeline, and contact. Make it landing-page-like, sharp, high-contrast, and conversion-oriented.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/998aed16-60a1-4d84-b60e-1ab093de8fa6/landing-consulting-deck.html",
      previewImage: LANDING_CONSULTING_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "landing-consulting-deck"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "landing-consulting-deck"
        ]["pop-art"],
      previewImages: LANDING_CONSULTING_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: LANDING_CONSULTING_PREVIEW_HTMLS,
      colorSystemId: "color-system:pop-art",
      designSystemId: "design-system:landing-consulting",
      templateId: "template:html-ppt-landing-consulting",
    },
    {
      slug: "lumina-creative-studio",
      title: "Lumina creative studio",
      prompt:
        "/gen presentation with design system `lumina` and template `html-ppt-lumina`, create a 15-slide portfolio deck for LensLab Studio, a photography and motion team pitching a beauty brand's global campaign shoot across studio sets, street casting, and social cutdowns. Include cover, agenda, studio point of view, campaign concept, team, production services, creative process, location plan, image gallery, motion deliverables, campaign metrics, client quotes, package options, and contact. Make it bold, sticker-tagged, sharp, and creative-studio oriented.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/08fe05a2-a7dd-4355-822d-14fb6a0987b3/lumina-creative-studio.html",
      previewImage: LUMINA_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "lumina-creative-studio"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "lumina-creative-studio"
        ]["prism"],
      previewImages: LUMINA_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: LUMINA_PREVIEW_HTMLS,
      colorSystemId: "color-system:prism",
      designSystemId: "design-system:lumina",
      templateId: "template:html-ppt-lumina",
    },
    {
      slug: "mosaic-geometric-pitch",
      title: "Mosaic geometric pitch",
      prompt:
        "/gen presentation with design system `mosaic-geometric` and template `html-ppt-mosaic-geometric`, create a 15-slide modular identity pitch for CivicLink, a new transit app unifying buses, bikes, scooters, and commuter rail under one visual system. Present it to city innovation leaders with cover, agenda, brand problem, design principles, logo grid, color and icon system, app moments, rollout process, station signage gallery, accessibility impact, pilot metrics, stakeholder quotes, implementation budget, and contact. Make it bold, modular, Bauhaus-geometric, and colourful.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/65f0f224-4bf0-4b11-9f3e-ddb1a11b1ec3/mosaic-geometric-pitch.html",
      previewImage: MOSAIC_GEOMETRIC_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "mosaic-geometric-pitch"
        ],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES[
          "mosaic-geometric-pitch"
        ]["carnival"],
      previewImages: MOSAIC_GEOMETRIC_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: MOSAIC_GEOMETRIC_PREVIEW_HTMLS,
      colorSystemId: "color-system:carnival",
      designSystemId: "design-system:mosaic-geometric",
      templateId: "template:html-ppt-mosaic-geometric",
    },
    {
      slug: "playful-pop-deck",
      title: "Playful pop",
      prompt:
        "/gen presentation with design system `playful-pop` and template `html-ppt-playful-pop`, create a 15-slide campus launch deck for FizzPop, a sparkling tea brand planning a colorful back-to-school sampling tour, creator challenge, and limited-edition flavor drop. Present it to retail and student ambassador partners with cover, agenda, brand world, audience insight, campaign idea, flavor lineup, activation map, event flow, content plan, gallery, reach metrics, partner testimonials, budget, and contact. Make it neon, bouncy, rounded, and pop-art playful.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/6b2f388a-119f-4ecc-8638-5cc309779b67/playful-pop-deck.html",
      previewImage: PLAYFUL_POP_PREVIEW_IMAGES[0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["playful-pop-deck"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["playful-pop-deck"][
          "pop-art"
        ],
      previewImages: PLAYFUL_POP_PREVIEW_IMAGES,
      slideCount: 15,
      previewHtmls: PLAYFUL_POP_PREVIEW_HTMLS,
      colorSystemId: "color-system:pop-art",
      designSystemId: "design-system:playful-pop",
      templateId: "template:html-ppt-playful-pop",
    },

    {
      slug: "bloom-pitch",
      title: "Bloom pitch",
      prompt:
        "/gen presentation with design system `bloom-pitch` and template `html-ppt-bloom-pitch`, create a 15-slide investor pitch for PetalLoop, a climate-friendly flower delivery marketplace raising a seed round. Include cover, agenda, market shift, customer problem, solution, product flow, traction, business model, go-to-market, competitive position, roadmap, team, financial plan, ask, and next steps. Make it playful, optimistic, organic, and investor-ready.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/d29707fb-9b85-44bc-be55-cf3cf082f68d/bloom-pitch.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["bloom-pitch"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["bloom-pitch"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["bloom-pitch"][
          "carnival"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["bloom-pitch"],
      slideCount: 15,
      colorSystemId: "color-system:carnival",
      designSystemId: "design-system:bloom-pitch",
      templateId: "template:html-ppt-bloom-pitch",
    },
    {
      slug: "blueprint-academy",
      title: "Blueprint academy",
      prompt:
        "/gen presentation with design system `blueprint-academy` and template `html-ppt-blueprint-academy`, create a 15-slide curriculum proposal for Northline Academy launching an applied AI certificate for working professionals. Present it to academic leadership with cover, agenda, program context, learner needs, curriculum map, module sequence, faculty team, classroom experience, assessment model, outcomes, partnerships, enrollment plan, budget, and next steps. Make it academic, structured, blueprint-like, and credible.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f64cd670-7565-483f-b872-117a18c0c414/blueprint-academy.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["blueprint-academy"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["blueprint-academy"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["blueprint-academy"][
          "forest-editorial"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["blueprint-academy"],
      slideCount: 15,
      colorSystemId: "color-system:forest-editorial",
      designSystemId: "design-system:blueprint-academy",
      templateId: "template:html-ppt-blueprint-academy",
    },
    {
      slug: "meridian",
      title: "Meridian",
      prompt:
        "/gen presentation with design system `meridian` and template `html-ppt-meridian`, create a 15-slide agency capabilities deck for Meridian Works, a data strategy studio helping enterprise teams modernize analytics operations. Present it to a prospective client executive team with cover, agenda, market context, client challenges, service model, team, process, case studies, measurement plan, operating rhythm, timeline, commercial model, and contact. Make it professional, sharp, data-led, and executive-ready.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/58cc240d-7d84-49a7-92ba-57eea4168730/meridian.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["meridian"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["meridian"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["meridian"][
          "slate-corporate"
        ],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["meridian"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      designSystemId: "design-system:meridian",
      templateId: "template:html-ppt-meridian",
    },
    {
      slug: "neo-brutalism",
      title: "Neo brutalism",
      prompt:
        "/gen presentation with design system `neo-brutalism` and template `html-ppt-neo-brutalism`, create a 15-slide founder pitch for BlockForge, a developer tooling startup launching a collaborative build system. Present it to early-stage investors with cover, agenda, problem, product, technical edge, market, traction, customer proof, business model, go-to-market, competition, roadmap, team, funding ask, and next steps. Make it bold, direct, high-contrast, and brutalist.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/4d8a4052-b43d-498a-81cc-b4c743103ff2/neo-brutalism.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["neo-brutalism"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["neo-brutalism"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["neo-brutalism"][
          "mono-ink"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["neo-brutalism"],
      slideCount: 15,
      colorSystemId: "color-system:mono-ink",
      designSystemId: "design-system:neo-brutalism",
      templateId: "template:html-ppt-neo-brutalism",
    },
    {
      slug: "nocturne",
      title: "Nocturne",
      prompt:
        "/gen presentation with design system `nocturne` and template `html-ppt-nocturne`, create a 15-slide annual keynote for NightOps Cloud reviewing reliability, infrastructure scale, and the roadmap for autonomous operations. Present it to technical customers with cover, agenda, state of the platform, usage growth, reliability metrics, architecture, product updates, customer stories, roadmap, ecosystem, pricing changes, and closing call to action. Make it dark, data-rich, polished, and keynote-ready.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/dd4ecb89-b6b1-4ed0-bfca-4ebf3db3a664/nocturne.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["nocturne"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["nocturne"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["nocturne"][
          "midnight-mono"
        ],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["nocturne"],
      slideCount: 15,
      colorSystemId: "color-system:midnight-mono",
      designSystemId: "design-system:nocturne",
      templateId: "template:html-ppt-nocturne",
    },
    {
      slug: "pixel-glitch",
      title: "Pixel glitch",
      prompt:
        "/gen presentation with design system `pixel-glitch` and template `html-ppt-pixel-glitch`, create a 15-slide creative studio deck for Arcade Signal pitching a retro-futurist campaign for an indie game launch. Present it to the publisher team with cover, agenda, audience insight, campaign concept, visual world, channel plan, creator program, launch timeline, asset gallery, performance targets, budget, team, and next steps. Make it pixelated, energetic, digital, and sharp.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/274e4cc3-d811-40a1-a091-526db9a62734/pixel-glitch.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["pixel-glitch"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["pixel-glitch"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["pixel-glitch"][
          "bauhaus-primary"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["pixel-glitch"],
      slideCount: 15,
      colorSystemId: "color-system:bauhaus-primary",
      designSystemId: "design-system:pixel-glitch",
      templateId: "template:html-ppt-pixel-glitch",
    },
    {
      slug: "prospectus",
      title: "Prospectus",
      prompt:
        "/gen presentation with design system `prospectus` and template `html-ppt-prospectus`, create a 15-slide business plan for Atlas Harbor, a B2B logistics platform expanding into regional fulfillment. Present it to strategic partners with cover, agenda, market context, customer problem, solution, operating model, product experience, growth plan, financial model, implementation roadmap, risks, team, partnership terms, and next steps. Make it corporate, polished, structured, and proposal-ready.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/64a9b8c5-f89d-4379-998c-9da755f7ca62/prospectus.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["prospectus"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["prospectus"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["prospectus"][
          "slate-corporate"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["prospectus"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      designSystemId: "design-system:prospectus",
      templateId: "template:html-ppt-prospectus",
    },
    {
      slug: "schoolhouse",
      title: "Schoolhouse",
      prompt:
        "/gen presentation with design system `schoolhouse` and template `html-ppt-schoolhouse`, create a 15-slide community education deck for Maple Hall launching a weekend skills program for families and local makers. Present it to city partners with cover, agenda, mission, audience needs, program tracks, sample day, instructor team, venue plan, safety approach, outcomes, testimonials, membership tiers, budget, and registration steps. Make it warm, retro, classroom-inspired, and approachable.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cb03f77b-982d-4708-8781-2a0ab450a4fb/schoolhouse.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["schoolhouse"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["schoolhouse"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["schoolhouse"][
          "bauhaus-primary"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["schoolhouse"],
      slideCount: 15,
      colorSystemId: "color-system:bauhaus-primary",
      designSystemId: "design-system:schoolhouse",
      templateId: "template:html-ppt-schoolhouse",
    },
    {
      slug: "sticker-scrapbook",
      title: "Sticker scrapbook",
      prompt:
        "/gen presentation with design system `sticker-scrapbook` and template `html-ppt-sticker-scrapbook`, create a 15-slide brand collaboration deck for Patch Party, a youth culture festival launching sponsor activations, creator booths, and collectible merch. Present it to brand partners with cover, agenda, audience story, event concept, activation zones, creator plan, media moments, sponsor packages, timeline, reach metrics, testimonials, budget, and contact. Make it vibrant, scrapbook-like, sticker-heavy, and celebratory.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/f15ccce7-90f1-4773-b4c8-c7eaf903ce76/sticker-scrapbook.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["sticker-scrapbook"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["sticker-scrapbook"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["sticker-scrapbook"][
          "prism"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["sticker-scrapbook"],
      slideCount: 15,
      colorSystemId: "color-system:prism",
      designSystemId: "design-system:sticker-scrapbook",
      templateId: "template:html-ppt-sticker-scrapbook",
    },
    {
      slug: "strata",
      title: "Strata",
      prompt:
        "/gen presentation with design system `strata` and template `html-ppt-strata`, create a 15-slide agency proposal for Strata Studio helping a fintech brand redesign its onboarding and lifecycle communications. Present it to the client leadership team with cover, agenda, business challenge, strategic principles, design direction, service scope, sprint process, sample work, measurement plan, timeline, investment, team, and next steps. Make it Swiss-minimal, precise, editorial, and agency-grade.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/040ddb5c-6819-436a-bd3a-87cb5de2be0e/strata.html",
      previewImage: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["strata"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["strata"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["strata"]["mono-ink"],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["strata"],
      slideCount: 15,
      colorSystemId: "color-system:mono-ink",
      designSystemId: "design-system:strata",
      templateId: "template:html-ppt-strata",
    },
    {
      slug: "taped-consulting",
      title: "Taped consulting",
      prompt:
        "/gen presentation with design system `taped-consulting` and template `html-ppt-taped-consulting`, create a 15-slide transformation proposal for Clearpath Advisory helping a healthcare network improve patient intake operations. Present it to operations executives with cover, agenda, current-state diagnosis, opportunity, engagement model, workstreams, field research, process redesign, timeline, proof metrics, testimonials, pricing, and next steps. Make it consulting-focused, tactile, polished, and persuasive.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/ffa53ff0-36b0-4bd1-b44a-4c2d8d66aaa6/taped-consulting.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["taped-consulting"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["taped-consulting"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["taped-consulting"][
          "slate-corporate"
        ],
      previewImages:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["taped-consulting"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      designSystemId: "design-system:taped-consulting",
      templateId: "template:html-ppt-taped-consulting",
    },
    {
      slug: "vantage",
      title: "Vantage",
      prompt:
        "/gen presentation with design system `vantage` and template `html-ppt-vantage`, create a 15-slide business proposal for Vantage Partners helping a robotics manufacturer launch a new service program. Present it to enterprise buyers with cover, agenda, market context, buyer pain points, proposed solution, service model, operating plan, proof metrics, roadmap, commercials, implementation timeline, team, and close. Make it business-focused, confident, structured, and modern.",
      embedUrl:
        "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/acada4b0-952c-4354-a382-56dcf49bb7e9/vantage.html",
      previewImage:
        PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["vantage"][0],
      cardPreviewImagesByTheme:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["vantage"],
      cardPreviewImage:
        PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_IMAGES["vantage"][
          "slate-corporate"
        ],
      previewImages: PRESENTATION_TEMPLATE_REFERENCE_PREVIEW_IMAGES["vantage"],
      slideCount: 15,
      colorSystemId: "color-system:slate-corporate",
      designSystemId: "design-system:vantage",
      templateId: "template:html-ppt-vantage",
    },
  ];
