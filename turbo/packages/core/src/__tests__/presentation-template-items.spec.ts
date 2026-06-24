import { describe, expect, it } from "vitest";
import {
  PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES,
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "../presentation-template-items";
import {
  findColorSystem,
  findDesignSystem,
  findTemplate,
} from "../resource-registry";

const FORBIDDEN_ASSET_URL_PARTS = [
  "drive.google.com",
  "googleusercontent.com",
  "raw.githubusercontent.com",
  "file://",
] as const;

const BOTANE_BORDERLESS_PREVIEW_IMAGES = [
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
] as const;

const BUSINESS_DATA_BORDERLESS_PREVIEW_IMAGES = [
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
] as const;

function stripRegistryPrefix(id: string, prefix: string): string {
  expect(id.startsWith(prefix)).toBe(true);
  return id.slice(prefix.length);
}

function expectCdnPreviewImages(
  item: (typeof PRESENTATION_TEMPLATE_PICKER_ITEMS)[number],
): void {
  expect(item.previewImages.length).toBeGreaterThan(0);
  expect(item.previewImage).toBe(item.previewImages[0]);

  for (const url of item.previewImages) {
    expect(url).toMatch(/^https:\/\/cdn\.vm0\.io\/artifacts\/.+\.png$/);
  }

  const assetUrls = [
    item.previewImage,
    item.cardPreviewImage,
    item.embedUrl,
    ...item.previewImages,
    ...(item.previewHtmls ?? []),
  ].filter((url): url is string => {
    return url !== undefined;
  });

  for (const url of assetUrls) {
    for (const forbidden of FORBIDDEN_ASSET_URL_PARTS) {
      expect(url).not.toContain(forbidden);
    }
  }
}

function expectCdnPreviewHtmls(
  item: (typeof PRESENTATION_TEMPLATE_PICKER_ITEMS)[number],
): void {
  expect(item.previewHtmls?.length).toBe(15);

  for (const url of item.previewHtmls ?? []) {
    expect(url).toMatch(/^https:\/\/cdn\.vm0\.io\/artifacts\/.+\.html$/);
  }
}

function expectR2ArchiveSource(
  id: string,
  sourcePath: string,
  archiveSha256?: string,
): void {
  const entry = id.startsWith("template:")
    ? findTemplate(id)
    : findDesignSystem(id);

  expect(entry, id).toBeDefined();
  if (!entry) {
    throw new Error(`missing registry entry ${id}`);
  }

  expect(entry.source.path).toBe(sourcePath);
  expect(entry.source.repo).toBeUndefined();
  expect(entry.source.ref).toBeUndefined();
  expect(entry.source.archive?.type).toBe("tar.gz");
  if (archiveSha256) {
    expect(entry.source.archive?.sha256).toBe(archiveSha256);
  } else {
    expect(entry.source.archive?.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(entry.source.archive).not.toHaveProperty("url");
}

function expectColorSystem(
  colorSystemId: string | undefined,
  expectedColorSystemId: string,
): void {
  expect(colorSystemId).toBe(expectedColorSystemId);
  expect(findColorSystem(colorSystemId ?? "")).toBeDefined();
}

const BATCH_PRESENTATION_PICKER_ITEMS = [
  {
    slug: "crayon-learning-deck",
    designSystemId: "design-system:crayon",
    templateId: "template:html-ppt-crayon",
    colorSystemId: "color-system:prism",
    designSourcePath: "presentation-design-system/crayon",
    templateSourcePath: "presentation-template/crayon",
  },
  {
    slug: "creative-agency-presentation",
    designSystemId: "design-system:creative-agency",
    templateId: "template:html-ppt-creative-agency",
    colorSystemId: "color-system:coral-studio",
    designSourcePath: "presentation-design-system/creative-agency",
    templateSourcePath: "presentation-template/creative-agency",
  },
  {
    slug: "data-report-presentation",
    designSystemId: "design-system:data-report",
    templateId: "template:html-ppt-data-report",
    colorSystemId: "color-system:prism",
    designSourcePath: "presentation-design-system/data-report",
    templateSourcePath: "presentation-template/data-report",
  },
  {
    slug: "editorial-magazine-deck",
    designSystemId: "design-system:editorial-magazine",
    templateId: "template:html-ppt-editorial-magazine",
    colorSystemId: "color-system:warm-sand",
    designSourcePath: "presentation-design-system/editorial-magazine",
    templateSourcePath: "presentation-template/editorial-magazine",
  },
  {
    slug: "landing-consulting-deck",
    designSystemId: "design-system:landing-consulting",
    templateId: "template:html-ppt-landing-consulting",
    colorSystemId: "color-system:pop-art",
    designSourcePath: "presentation-design-system/landing-consulting",
    templateSourcePath: "presentation-template/landing-consulting",
  },
  {
    slug: "lumina-creative-studio",
    designSystemId: "design-system:lumina",
    templateId: "template:html-ppt-lumina",
    colorSystemId: "color-system:prism",
    designSourcePath: "presentation-design-system/lumina",
    templateSourcePath: "presentation-template/lumina",
  },
  {
    slug: "mosaic-geometric-pitch",
    designSystemId: "design-system:mosaic-geometric",
    templateId: "template:html-ppt-mosaic-geometric",
    colorSystemId: "color-system:carnival",
    designSourcePath: "presentation-design-system/mosaic-geometric",
    templateSourcePath: "presentation-template/mosaic-geometric",
  },
  {
    slug: "playful-pop-deck",
    designSystemId: "design-system:playful-pop",
    templateId: "template:html-ppt-playful-pop",
    colorSystemId: "color-system:pop-art",
    designSourcePath: "presentation-design-system/playful-pop",
    templateSourcePath: "presentation-template/playful-pop",
  },
] as const;

const REFERENCE_PRESENTATION_PICKER_ITEMS = [
  {
    slug: "bloom-pitch",
    designSystemId: "design-system:bloom-pitch",
    templateId: "template:html-ppt-bloom-pitch",
    colorSystemId: "color-system:carnival",
    defaultThemeId: "carnival",
    designSourcePath: "presentation-design-system/bloom-pitch",
    templateSourcePath: "presentation-template/bloom-pitch",
  },
  {
    slug: "blueprint-academy",
    designSystemId: "design-system:blueprint-academy",
    templateId: "template:html-ppt-blueprint-academy",
    colorSystemId: "color-system:forest-editorial",
    defaultThemeId: "forest-editorial",
    designSourcePath: "presentation-design-system/blueprint-academy",
    templateSourcePath: "presentation-template/blueprint-academy",
  },
  {
    slug: "meridian",
    designSystemId: "design-system:meridian",
    templateId: "template:html-ppt-meridian",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
    designSourcePath: "presentation-design-system/meridian",
    templateSourcePath: "presentation-template/meridian",
  },
  {
    slug: "neo-brutalism",
    designSystemId: "design-system:neo-brutalism",
    templateId: "template:html-ppt-neo-brutalism",
    colorSystemId: "color-system:mono-ink",
    defaultThemeId: "mono-ink",
    designSourcePath: "presentation-design-system/neo-brutalism",
    templateSourcePath: "presentation-template/neo-brutalism",
  },
  {
    slug: "nocturne",
    designSystemId: "design-system:nocturne",
    templateId: "template:html-ppt-nocturne",
    colorSystemId: "color-system:midnight-mono",
    defaultThemeId: "midnight-mono",
    designSourcePath: "presentation-design-system/nocturne",
    templateSourcePath: "presentation-template/nocturne",
  },
  {
    slug: "pixel-glitch",
    designSystemId: "design-system:pixel-glitch",
    templateId: "template:html-ppt-pixel-glitch",
    colorSystemId: "color-system:bauhaus-primary",
    defaultThemeId: "bauhaus-primary",
    designSourcePath: "presentation-design-system/pixel-glitch",
    templateSourcePath: "presentation-template/pixel-glitch",
  },
  {
    slug: "prospectus",
    designSystemId: "design-system:prospectus",
    templateId: "template:html-ppt-prospectus",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
    designSourcePath: "presentation-design-system/prospectus",
    templateSourcePath: "presentation-template/prospectus",
  },
  {
    slug: "schoolhouse",
    designSystemId: "design-system:schoolhouse",
    templateId: "template:html-ppt-schoolhouse",
    colorSystemId: "color-system:bauhaus-primary",
    defaultThemeId: "bauhaus-primary",
    designSourcePath: "presentation-design-system/schoolhouse",
    templateSourcePath: "presentation-template/schoolhouse",
  },
  {
    slug: "sticker-scrapbook",
    designSystemId: "design-system:sticker-scrapbook",
    templateId: "template:html-ppt-sticker-scrapbook",
    colorSystemId: "color-system:prism",
    defaultThemeId: "prism",
    designSourcePath: "presentation-design-system/sticker-scrapbook",
    templateSourcePath: "presentation-template/sticker-scrapbook",
  },
  {
    slug: "strata",
    designSystemId: "design-system:strata",
    templateId: "template:html-ppt-strata",
    colorSystemId: "color-system:mono-ink",
    defaultThemeId: "mono-ink",
    designSourcePath: "presentation-design-system/strata",
    templateSourcePath: "presentation-template/strata",
  },
  {
    slug: "taped-consulting",
    designSystemId: "design-system:taped-consulting",
    templateId: "template:html-ppt-taped-consulting",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
    designSourcePath: "presentation-design-system/taped-consulting",
    templateSourcePath: "presentation-template/taped-consulting",
  },
  {
    slug: "vantage",
    designSystemId: "design-system:vantage",
    templateId: "template:html-ppt-vantage",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
    designSourcePath: "presentation-design-system/vantage",
    templateSourcePath: "presentation-template/vantage",
  },
] as const;

const PICKER_PROMPT_SCENARIOS = [
  {
    slug: "playful-launch-presentation",
    expectedSnippets: ["SproutPop", "people and culture leaders"],
  },
  {
    slug: "botane-organic-deck",
    expectedSnippets: ["Moss & Moon", "hospitality partners"],
  },
  {
    slug: "business-data-presentation",
    expectedSnippets: ["HarborCart", "leadership team"],
  },
  {
    slug: "crayon-learning-deck",
    expectedSnippets: ["Rainbow Lab", "families"],
  },
  {
    slug: "creative-agency-presentation",
    expectedSnippets: ["Northstar Studio", "client board"],
  },
  {
    slug: "data-report-presentation",
    expectedSnippets: ["MetroPulse", "urban planning stakeholders"],
  },
  {
    slug: "editorial-magazine-deck",
    expectedSnippets: ["Field Notes Quarterly", "premium sponsors"],
  },
  {
    slug: "landing-consulting-deck",
    expectedSnippets: ["ScaleBridge", "revenue leadership team"],
  },
  {
    slug: "lumina-creative-studio",
    expectedSnippets: ["LensLab Studio", "beauty brand's global campaign"],
  },
  {
    slug: "mosaic-geometric-pitch",
    expectedSnippets: ["CivicLink", "city innovation leaders"],
  },
  {
    slug: "playful-pop-deck",
    expectedSnippets: ["FizzPop", "retail and student ambassador partners"],
  },
] as const;

function expectOpenDesignSource(
  id: string,
  sourcePathPrefix: "design-systems/" | "design-templates/",
): void {
  const entry = id.startsWith("template:")
    ? findTemplate(id)
    : findDesignSystem(id);

  expect(entry, id).toBeDefined();
  if (!entry) {
    throw new Error(`missing registry entry ${id}`);
  }

  expect(entry.source.path).toMatch(new RegExp(`^${sourcePathPrefix}`));
  expect(entry.source.repo).toBeUndefined();
  expect(entry.source.ref).toBeUndefined();
  expect(entry.source.archive).toBeUndefined();
}

function expectPinnedPickerPreviewImages(
  slug: string,
  expectedPreviewImages: readonly string[],
): void {
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
    return candidate.slug === slug;
  });

  expect(item).toBeDefined();
  if (!item) {
    throw new Error(`missing ${slug} picker item`);
  }

  expect(item.previewImages).toEqual(expectedPreviewImages);
  expect(item.previewImage).toBe(expectedPreviewImages[0]);
  expect(new Set(item.previewImages).size).toBe(expectedPreviewImages.length);
  expectCdnPreviewImages(item);
}

describe("presentation template items", () => {
  const allPresentationItems = [
    ...PRESENTATION_TEMPLATE_ITEMS,
    ...PRESENTATION_TEMPLATE_PICKER_ITEMS,
  ];

  it("defines direct card preview assets for picker thumbnails", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.cardPreviewImage, item.slug).toMatch(
        /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\.jpg$/u,
      );
      expect(item.cardPreviewImage, item.slug).not.toContain("/cdn-cgi/image/");
    }
  });

  it("defines themed first-slide card preview assets for picker thumbnails", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.cardPreviewImagesByTheme, item.slug).toBeDefined();
      if (!item.cardPreviewImagesByTheme) {
        throw new Error(`missing themed card previews for ${item.slug}`);
      }

      expect(Object.keys(item.cardPreviewImagesByTheme).sort()).toEqual(
        [...PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES].sort(),
      );
      for (const themeId of PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES) {
        const url = item.cardPreviewImagesByTheme[themeId];
        expect(url, `${item.slug}:${themeId}`).toMatch(
          /^https:\/\/cdn\.vm0\.io\/artifacts\/.+-480x270\.jpg$/u,
        );
        expect(url, `${item.slug}:${themeId}`).not.toContain("/cdn-cgi/image/");
      }

      const defaultThemeId =
        item.colorSystemId?.replace("color-system:", "") ?? "warm-sand";
      expect(item.cardPreviewImage, item.slug).toBe(
        item.cardPreviewImagesByTheme[defaultThemeId],
      );
    }
  });

  it("defines slide counts for picker presentation scrub previews", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.slideCount, item.slug).toBe(15);
    }
  });

  it("resolve every design system and template against the resource registry", () => {
    for (const item of allPresentationItems) {
      const designSystem = findDesignSystem(item.designSystemId);
      const template = findTemplate(item.templateId);

      expect(designSystem, item.designSystemId).toBeDefined();
      expect(template, item.templateId).toBeDefined();
      expect(template?.targets).toContain("presentation");
    }
  });

  it("keeps prompt references aligned with structured ids", () => {
    for (const item of allPresentationItems) {
      const promptDesignSystem = stripRegistryPrefix(
        item.designSystemId,
        "design-system:",
      );
      const promptTemplate = stripRegistryPrefix(item.templateId, "template:");

      expect(item.prompt).toContain(`design system \`${promptDesignSystem}\``);
      expect(item.prompt).toContain(`template \`${promptTemplate}\``);
    }
  });

  it("keeps picker prompts tied to concrete demo scenarios", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.prompt, item.slug).not.toMatch(
        /\bcreate a 15-slide presentation for\b/i,
      );
    }

    for (const scenario of PICKER_PROMPT_SCENARIOS) {
      const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
        return candidate.slug === scenario.slug;
      });

      expect(item, scenario.slug).toBeDefined();
      if (!item) {
        throw new Error(`missing ${scenario.slug} picker item`);
      }

      for (const snippet of scenario.expectedSnippets) {
        expect(item.prompt, scenario.slug).toContain(snippet);
      }
    }
  });

  it("defines explicit preview image arrays", () => {
    for (const item of allPresentationItems) {
      expect(Array.isArray(item.previewImages)).toBe(true);
    }
  });

  it("pins borderless picker preview image manifests", () => {
    expectPinnedPickerPreviewImages(
      "botane-organic-deck",
      BOTANE_BORDERLESS_PREVIEW_IMAGES,
    );
    expectPinnedPickerPreviewImages(
      "business-data-presentation",
      BUSINESS_DATA_BORDERLESS_PREVIEW_IMAGES,
    );
  });

  it("keeps the legacy catalog available and resolvable", () => {
    const legacyItem = PRESENTATION_TEMPLATE_ITEMS.find((candidate) => {
      return candidate.slug === "starship-v3-investor-update";
    });

    expect(legacyItem).toBeDefined();
    expect(
      PRESENTATION_TEMPLATE_PICKER_ITEMS.some((candidate) => {
        return candidate.slug === legacyItem?.slug;
      }),
    ).toBe(false);
    expect(legacyItem?.designSystemId).toBe("design-system:spacex");
    expect(legacyItem?.templateId).toBe("template:html-ppt-pitch-deck");
    expect(findDesignSystem(legacyItem?.designSystemId ?? "")).toBeDefined();
    expect(findTemplate(legacyItem?.templateId ?? "")?.targets).toContain(
      "presentation",
    );
  });

  it("keeps legacy presentation templates on the Open Design source path", () => {
    for (const item of PRESENTATION_TEMPLATE_ITEMS) {
      expectOpenDesignSource(item.designSystemId, "design-systems/");
      expectOpenDesignSource(item.templateId, "design-templates/");
    }
  });

  it("keeps the picker catalog separate from the legacy catalog", () => {
    expect(
      PRESENTATION_TEMPLATE_ITEMS.some((candidate) => {
        return candidate.slug === "playful-launch-presentation";
      }),
    ).toBe(false);

    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "playful-launch-presentation";
    });

    expect(item).toBeDefined();
    if (!item) {
      throw new Error("missing playful-launch-presentation picker item");
    }

    expect(item.designSystemId).toBe("design-system:playful-editorial");
    expect(item.templateId).toBe("template:html-ppt-playful-launch");
    expectColorSystem(item.colorSystemId, "color-system:carnival");
    expect(item.slideCount).toBe(15);
    expect(item.previewImages.length).toBe(15);
    expect(item.previewImage).toBe(item.previewImages[0]);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/playful-launch-presentation\.html$/,
    );
    expectCdnPreviewImages(item);
    expect(findDesignSystem(item.designSystemId)).toBeDefined();
    expect(findTemplate(item.templateId)?.targets).toContain("presentation");
    expectR2ArchiveSource(
      item.designSystemId,
      "presentation-design-system/playful-editorial",
    );
    expectR2ArchiveSource(item.templateId, "presentation-template/aplocoto");
  });

  it("keeps the business data picker item aligned with CDN assets", () => {
    expect(
      PRESENTATION_TEMPLATE_ITEMS.some((candidate) => {
        return candidate.slug === "business-data-presentation";
      }),
    ).toBe(false);

    const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "business-data-presentation";
    });

    expect(item).toBeDefined();
    if (!item) {
      throw new Error("missing business-data-presentation picker item");
    }

    expect(item.designSystemId).toBe("design-system:business-data");
    expect(item.templateId).toBe("template:html-ppt-business-data");
    expectColorSystem(item.colorSystemId, "color-system:berry-pop");
    expect(item.slideCount).toBe(15);
    expect(item.previewImages.length).toBe(15);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/business-data-presentation\.html$/,
    );
    expectCdnPreviewImages(item);
    expect(findDesignSystem(item.designSystemId)).toBeDefined();
    expect(findTemplate(item.templateId)?.targets).toContain("presentation");
    expectR2ArchiveSource(
      item.designSystemId,
      "presentation-design-system/business-data",
    );
    expectR2ArchiveSource(
      item.templateId,
      "presentation-template/business-data",
    );
  });

  it("keeps the batch picker items aligned with CDN assets and private R2 sources", () => {
    for (const expected of BATCH_PRESENTATION_PICKER_ITEMS) {
      const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
        return candidate.slug === expected.slug;
      });

      expect(item, expected.slug).toBeDefined();
      if (!item) {
        throw new Error(`missing ${expected.slug} picker item`);
      }

      expect(item.designSystemId).toBe(expected.designSystemId);
      expect(item.templateId).toBe(expected.templateId);
      expectColorSystem(item.colorSystemId, expected.colorSystemId);
      expect(item.slideCount).toBe(15);
      expect(item.previewImages.length).toBe(15);
      expect(item.previewImage).toBe(item.previewImages[0]);
      expect(item.embedUrl).toMatch(
        /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/[^/]+\.html$/,
      );
      expectCdnPreviewImages(item);
      expectCdnPreviewHtmls(item);
      expect(findDesignSystem(item.designSystemId)).toBeDefined();
      expect(findTemplate(item.templateId)?.targets).toContain("presentation");
      expectR2ArchiveSource(item.designSystemId, expected.designSourcePath);
      expectR2ArchiveSource(item.templateId, expected.templateSourcePath);
    }
  });

  it("keeps the reference picker items aligned with CDN assets and private R2 sources", () => {
    for (const expected of REFERENCE_PRESENTATION_PICKER_ITEMS) {
      const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
        return candidate.slug === expected.slug;
      });

      expect(item, expected.slug).toBeDefined();
      if (!item) {
        throw new Error(`missing ${expected.slug} picker item`);
      }

      expect(item.designSystemId).toBe(expected.designSystemId);
      expect(item.templateId).toBe(expected.templateId);
      expectColorSystem(item.colorSystemId, expected.colorSystemId);
      expect(item.slideCount).toBe(15);
      expect(item.previewImages.length).toBe(1);
      expect(item.previewImage).toBe(item.previewImages[0]);
      expect(item.previewHtmls).toBeUndefined();
      expect(item.embedUrl).toMatch(
        /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/[^/]+\.html$/,
      );
      expectCdnPreviewImages(item);
      expect(item.cardPreviewImage).toBe(
        item.cardPreviewImagesByTheme?.[expected.defaultThemeId],
      );
      expect(findDesignSystem(item.designSystemId)).toBeDefined();
      expect(findTemplate(item.templateId)?.targets).toContain("presentation");
      expectR2ArchiveSource(item.designSystemId, expected.designSourcePath);
      expectR2ArchiveSource(item.templateId, expected.templateSourcePath);
    }
  });

  it("registers non-picker presentation templates on private R2 sources", () => {
    const entries = [
      {
        designSystemId: "design-system:nocturne",
        templateId: "template:html-ppt-nocturne",
        designSourcePath: "presentation-design-system/nocturne",
        templateSourcePath: "presentation-template/nocturne",
      },
      {
        designSystemId: "design-system:neo-brutalism",
        templateId: "template:html-ppt-neo-brutalism",
        designSourcePath: "presentation-design-system/neo-brutalism",
        templateSourcePath: "presentation-template/neo-brutalism",
      },
      {
        designSystemId: "design-system:bloom-pitch",
        templateId: "template:html-ppt-bloom-pitch",
        designSourcePath: "presentation-design-system/bloom-pitch",
        templateSourcePath: "presentation-template/bloom-pitch",
        designArchiveSha256:
          "5b7b8f959cef7a3f5ea4eb86e95152845013425365683e4d7efe6c7c5ecc2b48",
        templateArchiveSha256:
          "0176ccac0f36b5921ebfcdc998e2273f57a3d79644213eb01000dc4e0e23dcd5",
      },
      {
        designSystemId: "design-system:blueprint-academy",
        templateId: "template:html-ppt-blueprint-academy",
        designSourcePath: "presentation-design-system/blueprint-academy",
        templateSourcePath: "presentation-template/blueprint-academy",
        designArchiveSha256:
          "9a5fdb160ae3691513567279401e9a8766c892e0bb80caae6eef3c08a54c0416",
        templateArchiveSha256:
          "00b01b07095965f68971e4593cf563562a32b75f49ff4be186be5c81eb6e8330",
      },
      {
        designSystemId: "design-system:meridian",
        templateId: "template:html-ppt-meridian",
        designSourcePath: "presentation-design-system/meridian",
        templateSourcePath: "presentation-template/meridian",
        designArchiveSha256:
          "6a00cba7ddd2fcb74e8c89c0063d33bba5fe2e190c15b4634d4a56b2334f527e",
        templateArchiveSha256:
          "571bc5d0a35fe3db2ddb2ddc2b0aa3b11bb52532da3fc2eb76d84af885710302",
      },
      {
        designSystemId: "design-system:pixel-glitch",
        templateId: "template:html-ppt-pixel-glitch",
        designSourcePath: "presentation-design-system/pixel-glitch",
        templateSourcePath: "presentation-template/pixel-glitch",
        designArchiveSha256:
          "18ce63a66658c7002d3ebea135dc7274b2dac4033c0e98c6e508c7a249fe93a2",
        templateArchiveSha256:
          "d16f2913aed0dba0384795db45aa67e6a697d1ae1c31c6a43ff16b8a975dfc18",
      },
      {
        designSystemId: "design-system:prospectus",
        templateId: "template:html-ppt-prospectus",
        designSourcePath: "presentation-design-system/prospectus",
        templateSourcePath: "presentation-template/prospectus",
        designArchiveSha256:
          "01e9e6b1f0ea17e3a65c2af7c76cff317b095005c4020ce20eba22e5d63430b6",
        templateArchiveSha256:
          "99430b2bd063eb1c922ef22ca95fbe783ab0646b7bdfbb6b7a8b5c839cad5ba0",
      },
      {
        designSystemId: "design-system:schoolhouse",
        templateId: "template:html-ppt-schoolhouse",
        designSourcePath: "presentation-design-system/schoolhouse",
        templateSourcePath: "presentation-template/schoolhouse",
        designArchiveSha256:
          "a4a7be65e2adca9eb5572f92b3f49075e768da305b833d74b703da5f2dd3d271",
        templateArchiveSha256:
          "4824967cf53a03098aca8c6ca3ea34938d848ff372a556f47ac66a608f81f5db",
      },
      {
        designSystemId: "design-system:sticker-scrapbook",
        templateId: "template:html-ppt-sticker-scrapbook",
        designSourcePath: "presentation-design-system/sticker-scrapbook",
        templateSourcePath: "presentation-template/sticker-scrapbook",
        designArchiveSha256:
          "d50129981c3dc3b51b4c63b2ac36b9b5fe6783953bbea3546e372903c8596cad",
        templateArchiveSha256:
          "e289743180d623e6a0966ab85d0737686914445c1b749901cfbbf061958cc334",
      },
      {
        designSystemId: "design-system:strata",
        templateId: "template:html-ppt-strata",
        designSourcePath: "presentation-design-system/strata",
        templateSourcePath: "presentation-template/strata",
        designArchiveSha256:
          "91a45f8c3b70d7c43505ca7fe51f55ab36a08312e28867383ef885a7a7e63c28",
        templateArchiveSha256:
          "ff9c81d11d866f98bbe9cf5e8584adcb3cb28095b734ca02dd1e750ace6f9e49",
      },
      {
        designSystemId: "design-system:taped-consulting",
        templateId: "template:html-ppt-taped-consulting",
        designSourcePath: "presentation-design-system/taped-consulting",
        templateSourcePath: "presentation-template/taped-consulting",
        designArchiveSha256:
          "9fb58db77455a3bc7ccdd106b18c99a3d62bc53981f494577804b496a78a858e",
        templateArchiveSha256:
          "df64d3f8d5a63e892eeaf5b7723d7274e4147359eda558e1b34aab27e30c439d",
      },
      {
        designSystemId: "design-system:vantage",
        templateId: "template:html-ppt-vantage",
        designSourcePath: "presentation-design-system/vantage",
        templateSourcePath: "presentation-template/vantage",
        designArchiveSha256:
          "8338e31f3aa18538d36ae363d3ac2aa0ec56669c33494fdf2a12286d9b0523a8",
        templateArchiveSha256:
          "0d4c276d8dc7710a484d4d7c9bfb05f0a68b378d50e73aea6a6eb92698daa6fe",
      },
    ] as const;

    for (const entry of entries) {
      expect(findDesignSystem(entry.designSystemId)).toBeDefined();
      expect(findTemplate(entry.templateId)?.targets).toContain("presentation");
      expectR2ArchiveSource(
        entry.designSystemId,
        entry.designSourcePath,
        "designArchiveSha256" in entry ? entry.designArchiveSha256 : undefined,
      );
      expectR2ArchiveSource(
        entry.templateId,
        entry.templateSourcePath,
        "templateArchiveSha256" in entry
          ? entry.templateArchiveSha256
          : undefined,
      );
    }
  });

  it("keeps the botane picker item aligned with CDN assets", () => {
    const botaneItem = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
      return candidate.slug === "botane-organic-deck";
    });

    expect(botaneItem).toBeDefined();
    if (!botaneItem) {
      throw new Error("Botane picker item is missing");
    }
    expect(botaneItem.designSystemId).toBe("design-system:botane-organic");
    expect(botaneItem.templateId).toBe("template:html-ppt-botane-organic");
    expectColorSystem(botaneItem.colorSystemId, "color-system:mauve-dusk");
    expect(botaneItem.previewImages.length).toBe(15);
    expect(botaneItem.previewImage).toBe(botaneItem.previewImages[0]);
    expect(botaneItem.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/botane-organic-deck\.html$/,
    );
    expectCdnPreviewImages(botaneItem);
    expect(findDesignSystem(botaneItem.designSystemId)).toBeDefined();
    expect(findTemplate(botaneItem.templateId)?.targets).toContain(
      "presentation",
    );
    expectR2ArchiveSource(
      botaneItem.designSystemId,
      "presentation-design-system/botane-organic",
    );
    expectR2ArchiveSource(
      botaneItem.templateId,
      "presentation-template/botane-organic",
    );
  });
});
