import { describe, expect, it } from "vitest";
import {
  PRESENTATION_TEMPLATE_PICKER_CARD_PREVIEW_THEMES,
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
} from "../presentation-template-items";
import {
  findColorSystem,
  findPresentationRunbookPackage,
  listTemplates,
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
    runbookId: "presentation-runbook:crayon",
    colorSystemId: "color-system:prism",
  },
  {
    slug: "creative-agency-presentation",
    runbookId: "presentation-runbook:creative-agency",
    colorSystemId: "color-system:coral-studio",
  },
  {
    slug: "data-report-presentation",
    runbookId: "presentation-runbook:data-report",
    colorSystemId: "color-system:prism",
  },
  {
    slug: "editorial-magazine-deck",
    runbookId: "presentation-runbook:editorial-magazine",
    colorSystemId: "color-system:warm-sand",
  },
  {
    slug: "landing-consulting-deck",
    runbookId: "presentation-runbook:landing-consulting",
    colorSystemId: "color-system:pop-art",
  },
  {
    slug: "lumina-creative-studio",
    runbookId: "presentation-runbook:lumina",
    colorSystemId: "color-system:prism",
  },
  {
    slug: "mosaic-geometric-pitch",
    runbookId: "presentation-runbook:mosaic-geometric",
    colorSystemId: "color-system:carnival",
  },
  {
    slug: "playful-pop-deck",
    runbookId: "presentation-runbook:playful-pop",
    colorSystemId: "color-system:pop-art",
  },
] as const;

const REFERENCE_PRESENTATION_PICKER_ITEMS = [
  {
    slug: "bloom-pitch",
    runbookId: "presentation-runbook:bloom-pitch",
    colorSystemId: "color-system:carnival",
    defaultThemeId: "carnival",
  },
  {
    slug: "blueprint-academy",
    runbookId: "presentation-runbook:blueprint-academy",
    colorSystemId: "color-system:forest-editorial",
    defaultThemeId: "forest-editorial",
  },
  {
    slug: "meridian",
    runbookId: "presentation-runbook:meridian",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
  },
  {
    slug: "neo-brutalism",
    runbookId: "presentation-runbook:neo-brutalism",
    colorSystemId: "color-system:mono-ink",
    defaultThemeId: "mono-ink",
  },
  {
    slug: "nocturne",
    runbookId: "presentation-runbook:nocturne",
    colorSystemId: "color-system:midnight-mono",
    defaultThemeId: "midnight-mono",
  },
  {
    slug: "pixel-glitch",
    runbookId: "presentation-runbook:pixel-glitch",
    colorSystemId: "color-system:bauhaus-primary",
    defaultThemeId: "bauhaus-primary",
  },
  {
    slug: "prospectus",
    runbookId: "presentation-runbook:prospectus",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
  },
  {
    slug: "schoolhouse",
    runbookId: "presentation-runbook:schoolhouse",
    colorSystemId: "color-system:bauhaus-primary",
    defaultThemeId: "bauhaus-primary",
  },
  {
    slug: "sticker-scrapbook",
    runbookId: "presentation-runbook:sticker-scrapbook",
    colorSystemId: "color-system:prism",
    defaultThemeId: "prism",
  },
  {
    slug: "strata",
    runbookId: "presentation-runbook:strata",
    colorSystemId: "color-system:mono-ink",
    defaultThemeId: "mono-ink",
  },
  {
    slug: "taped-consulting",
    runbookId: "presentation-runbook:taped-consulting",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
  },
  {
    slug: "vantage",
    runbookId: "presentation-runbook:vantage",
    colorSystemId: "color-system:slate-corporate",
    defaultThemeId: "slate-corporate",
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

  it("keeps picker items on runbook packages after retiring the legacy catalog", () => {
    expect(PRESENTATION_TEMPLATE_ITEMS).toHaveLength(0);
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      // Picker selections resolve to self-contained runbook packages; legacy
      // registry entries have been retired.
      expect(
        findPresentationRunbookPackage(item.runbookId),
        item.runbookId,
      ).toBeDefined();
      expect(findColorSystem(item.colorSystemId ?? "")).toBeDefined();
    }
  });

  it("keeps picker prompts free of retired registry selector language", () => {
    for (const item of PRESENTATION_TEMPLATE_PICKER_ITEMS) {
      expect(item.prompt).not.toContain("template `");
      expect(item.prompt).not.toContain("design system `");
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

  it("removes the legacy demo-only catalog", () => {
    expect(PRESENTATION_TEMPLATE_ITEMS).toEqual([]);
  });

  it("does not expose Open Design presentation registry entries", () => {
    expect(listTemplates("presentation")).toHaveLength(0);
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
    expect(item.runbookId).toBe("presentation-runbook:playful-launch");
    expectColorSystem(item.colorSystemId, "color-system:carnival");
    expect(item.slideCount).toBe(15);
    expect(item.previewImages.length).toBe(15);
    expect(item.previewImage).toBe(item.previewImages[0]);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/playful-launch-presentation\.html$/,
    );
    expectCdnPreviewImages(item);
    expect(
      findPresentationRunbookPackage(item.runbookId),
      item.runbookId,
    ).toBeDefined();
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
    expect(item.runbookId).toBe("presentation-runbook:business-data");
    expectColorSystem(item.colorSystemId, "color-system:berry-pop");
    expect(item.slideCount).toBe(15);
    expect(item.previewImages.length).toBe(15);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/business-data-presentation\.html$/,
    );
    expectCdnPreviewImages(item);
    expect(
      findPresentationRunbookPackage(item.runbookId),
      item.runbookId,
    ).toBeDefined();
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
      expect(item.runbookId).toBe(expected.runbookId);
      expectColorSystem(item.colorSystemId, expected.colorSystemId);
      expect(item.slideCount).toBe(15);
      expect(item.previewImages.length).toBe(15);
      expect(item.previewImage).toBe(item.previewImages[0]);
      expect(item.embedUrl).toMatch(
        /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/[^/]+\.html$/,
      );
      expectCdnPreviewImages(item);
      expectCdnPreviewHtmls(item);
      expect(
        findPresentationRunbookPackage(item.runbookId),
        item.runbookId,
      ).toBeDefined();
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
      expect(item.runbookId).toBe(expected.runbookId);
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
      expect(
        findPresentationRunbookPackage(item.runbookId),
        item.runbookId,
      ).toBeDefined();
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
    expect(botaneItem.runbookId).toBe("presentation-runbook:botane-organic");
    expectColorSystem(botaneItem.colorSystemId, "color-system:mauve-dusk");
    expect(botaneItem.previewImages.length).toBe(15);
    expect(botaneItem.previewImage).toBe(botaneItem.previewImages[0]);
    expect(botaneItem.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/botane-organic-deck\.html$/,
    );
    expectCdnPreviewImages(botaneItem);
    expect(
      findPresentationRunbookPackage(botaneItem.runbookId),
      botaneItem.runbookId,
    ).toBeDefined();
  });
});
