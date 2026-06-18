import { describe, expect, it } from "vitest";
import {
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
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/c55e2b08-4242-4ce7-99e2-6e37440c3709/slide-01.png",
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
  "https://cdn.vm0.io/artifacts/user_3EWY21Oe3f15kfs3yYmbGgDb3NV/cc1a93e1-e55d-4e40-b562-ef5f265ff79c/slide-01.png",
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
    item.embedUrl,
    ...item.previewImages,
    ...(item.previewHtmls ?? []),
  ];

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

function expectR2ArchiveSource(id: string, sourcePath: string): void {
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
  expect(entry.source.archive?.sha256).toMatch(/^[a-f0-9]{64}$/);
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
    expect(item.previewImages.length).toBe(15);
    expect(item.previewImage).toBe(item.previewImages[0]);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/aplocoto\.html$/,
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
    expect(item.previewImages.length).toBe(15);
    expect(item.embedUrl).toMatch(
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/business-data\.html$/,
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
    ] as const;

    for (const entry of entries) {
      expect(findDesignSystem(entry.designSystemId)).toBeDefined();
      expect(findTemplate(entry.templateId)?.targets).toContain("presentation");
      expectR2ArchiveSource(entry.designSystemId, entry.designSourcePath);
      expectR2ArchiveSource(entry.templateId, entry.templateSourcePath);
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
      /^https:\/\/cdn\.vm0\.io\/artifacts\/.+\/botane-organic\.html$/,
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
