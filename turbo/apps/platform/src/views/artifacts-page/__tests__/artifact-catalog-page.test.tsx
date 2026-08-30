import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { i18n } from "../../../i18n/index.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();

const CATALOG_USER_ID = "test-user-artifact-catalog";
const CATALOG_ORG_ID = "org_artifact_catalog";

function artifact(overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    id: "a0000000-0000-4000-a000-000000000001",
    kind: "file",
    title: "launch-plan.txt",
    thumbnail: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function setupArtifactCatalogPage(
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {
    [FeatureSwitchKey.SharedThreadSharing]: true,
  },
  path = "/artifacts",
): void {
  detachedSetupPage({
    context,
    path,
    user: { id: CATALOG_USER_ID, fullName: "Test User" },
    org: {
      activeOrg: { id: CATALOG_ORG_ID, name: "Test Org" },
      memberships: [{ id: CATALOG_ORG_ID }],
    },
    featureSwitches,
  });
}

function buttonByLabel(label: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((element) => {
    return element.getAttribute("aria-label") === label;
  });
}

async function findCard(title: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const card = buttonByLabel(
      i18n.t(
        ($) => {
          return $.artifacts.catalog.cardPreview;
        },
        { title },
      ),
    );
    if (!card) {
      throw new Error(`Expected a catalog card for ${title}`);
    }
    return card;
  });
}

describe("artifact catalog page", () => {
  it("renders artifacts with their kind and resized thumbnails", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [
          artifact({ title: "launch-plan.txt" }),
          artifact({
            id: "a0000000-0000-4000-a000-000000000002",
            kind: "hosted-site",
            title: "launch-site",
            thumbnail: {
              url: "https://cdn.vm0.io/artifacts/test/preview.webp",
            },
          }),
          artifact({
            id: "a0000000-0000-4000-a000-000000000003",
            kind: "avatar",
            title: "avatar-video.mp4",
          }),
        ],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();

    await findCard("launch-plan.txt");
    const site = await findCard("launch-site");
    expect(
      screen.getByTestId("artifact-catalog-kind-icon-hosted-site"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("artifact-catalog-kind-icon-avatar"),
    ).toBeInTheDocument();
    expect(site.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.vm0.io/cdn-cgi/image/width=640,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/test/preview.webp",
    );
  });

  it("keeps the kind filter outside the scrolling catalog region", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ kind: "presentation", title: "launch-deck" })],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();

    const card = await findCard("launch-deck");
    const filter = buttonByLabel(
      i18n.t(($) => {
        return $.artifacts.catalog.filters.presentationAria;
      }),
    );
    if (!filter) {
      throw new Error("Expected the presentation kind filter to render");
    }
    const viewport = document.querySelector("main");
    if (!viewport) {
      throw new Error("Expected the artifacts page to render a scroll region");
    }

    // The filter stays pinned only while it lives outside the scroll
    // container; moving it back inside would silently scroll it away.
    expect(viewport.contains(filter)).toBeFalsy();
    expect(viewport.contains(card)).toBeTruthy();
  });

  it("defaults to presentations and uses the requested filter order", async () => {
    const requestedKinds: (string | undefined)[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      requestedKinds.push(query.kind);
      const avatarSelected = query.kind === "avatar";
      return respond(200, {
        artifacts: [
          artifact({
            kind: avatarSelected ? "avatar" : "presentation",
            title: avatarSelected ? "avatar-video.mp4" : "launch-deck",
          }),
        ],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();
    await findCard("launch-deck");

    const kindFilterGroup = document.querySelector<HTMLElement>(
      '[aria-label="Artifact kind filters"]',
    );
    if (!kindFilterGroup) {
      throw new Error("Expected artifact kind filters");
    }
    const kindFilters = queryAllByRoleFast("button", kindFilterGroup);
    expect(
      kindFilters.map((button) => {
        return button.textContent;
      }),
    ).toStrictEqual([
      "Presentations",
      "Websites",
      "Images",
      "Videos",
      "Avatars",
      "Shared conversations",
      "Files",
    ]);
    expect(buttonByLabel("Show all artifacts")).toBeUndefined();
    expect(buttonByLabel("Show presentation artifacts")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(requestedKinds).toStrictEqual(["presentation"]);

    const avatarFilter = buttonByLabel("Show avatar artifacts");
    if (!avatarFilter) {
      throw new Error("Expected an avatar kind filter");
    }
    await click(avatarFilter);

    await findCard("avatar-video.mp4");
    expect(requestedKinds).toStrictEqual(["presentation", "avatar"]);
  });

  it("syncs the selected artifact tab with browser history", async () => {
    const requestedKinds: (string | undefined)[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      requestedKinds.push(query.kind);
      const kind = query.kind ?? "presentation";
      return respond(200, {
        artifacts: [artifact({ kind, title: `${kind}-artifact` })],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage(undefined, "/artifacts?tab=image");
    await findCard("image-artifact");
    expect(buttonByLabel("Show image artifacts")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(new URLSearchParams(search()).get("tab")).toBe("image");

    const videoFilter = buttonByLabel("Show video artifacts");
    if (!videoFilter) {
      throw new Error("Expected a video kind filter");
    }
    await click(videoFilter);
    await findCard("video-artifact");
    expect(new URLSearchParams(search()).get("tab")).toBe("video");

    act(() => {
      window.history.back();
    });

    await findCard("image-artifact");
    expect(buttonByLabel("Show image artifacts")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(new URLSearchParams(search()).get("tab")).toBe("image");
    expect(requestedKinds.slice(0, 2)).toStrictEqual(["image", "video"]);
    expect(requestedKinds.at(-1)).toBe("image");
  });

  it("opens a routed artifact and restores its card when the preview closes", async () => {
    const targetArtifactId = "a0000000-0000-4000-a000-000000000099";
    const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      if (query.cursor === "image-cursor-2") {
        return respond(200, {
          artifacts: [
            artifact({
              id: targetArtifactId,
              kind: "image",
              title: "selected-image.png",
            }),
          ],
          nextCursor: null,
        });
      }
      return respond(200, {
        artifacts: [
          artifact({
            id: "a0000000-0000-4000-a000-000000000098",
            kind: "image",
            title: "recent-image.png",
          }),
        ],
        nextCursor: "image-cursor-2",
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
      expect(params.artifactId).toBe(targetArtifactId);
      return respond(200, {
        ...artifact({
          id: targetArtifactId,
          kind: "image",
          title: "selected-image.png",
        }),
        kind: "image",
        file: {
          id: "f0000000-0000-4000-a000-000000000099",
          filename: "selected-image.png",
          contentType: "image/png",
          size: 4096,
          url: "https://artifacts.example.com/selected-image.png",
          previewImageUrl: null,
        },
        model: "image-model",
        provider: "image-provider",
      });
    });

    setupArtifactCatalogPage(
      undefined,
      `/artifacts?tab=image&artifact=${targetArtifactId}`,
    );

    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute(
      "src",
      "https://artifacts.example.com/selected-image.png",
    );
    expect(pathname()).toBe("/artifacts");
    expect(new URLSearchParams(search()).get("tab")).toBe("image");
    expect(new URLSearchParams(search()).get("artifact")).toBe(
      targetArtifactId,
    );
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    });

    await click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
      expect(new URLSearchParams(search()).has("artifact")).toBeFalsy();
    });
    expect(pathname()).toBe("/artifacts");
    expect(new URLSearchParams(search()).get("tab")).toBe("image");
    await findCard("selected-image.png");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("keeps the avatar filter visible while avatar artifacts load", async () => {
    const releaseAvatarResponse = context.mocks.deferred<void>();
    context.mocks.api(
      artifactCatalogContract.list,
      async ({ query, respond }) => {
        if (query.kind === "avatar") {
          await releaseAvatarResponse.promise;
          return respond(200, {
            artifacts: [
              artifact({ kind: "avatar", title: "avatar-video.mp4" }),
            ],
            nextCursor: null,
          });
        }
        return respond(200, {
          artifacts: [artifact({ kind: "presentation", title: "launch-deck" })],
          nextCursor: null,
        });
      },
    );

    setupArtifactCatalogPage();
    await findCard("launch-deck");

    const avatarFilter = buttonByLabel("Show avatar artifacts");
    if (!avatarFilter) {
      throw new Error("Expected an avatar kind filter");
    }
    click(avatarFilter);

    await expect(
      screen.findByLabelText("Loading artifacts"),
    ).resolves.toBeInTheDocument();
    expect(buttonByLabel("Show avatar artifacts")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await act(async () => {
      releaseAvatarResponse.resolve();
      await releaseAvatarResponse.promise;
    });
    await findCard("avatar-video.mp4");
  });

  it("shows feature-switched filters while the first page loads", async () => {
    const requestStarted = context.mocks.deferred<void>();
    const releaseResponse = context.mocks.deferred<void>();
    context.mocks.api(artifactCatalogContract.list, async ({ respond }) => {
      requestStarted.resolve();
      await releaseResponse.promise;
      return respond(200, {
        artifacts: [artifact({ kind: "presentation", title: "launch-deck" })],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();
    await requestStarted.promise;

    expect(screen.getByLabelText("Loading artifacts")).toBeInTheDocument();
    expect(buttonByLabel("Show avatar artifacts")).toBeInTheDocument();
    expect(
      buttonByLabel("Show shared conversation artifacts"),
    ).toBeInTheDocument();

    await act(async () => {
      releaseResponse.resolve();
      await releaseResponse.promise;
    });
    await findCard("launch-deck");
  });

  it("hides shared conversations when sharing is disabled", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ kind: "presentation", title: "launch-deck" })],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage({
      [FeatureSwitchKey.SharedThreadSharing]: false,
    });
    await findCard("launch-deck");

    expect(buttonByLabel("Show avatar artifacts")).toBeInTheDocument();
    expect(buttonByLabel("Show shared conversation artifacts")).toBeUndefined();
  });

  it("renders shared conversations as compact rows", async () => {
    const sharedRequestStarted = context.mocks.deferred<void>();
    const releaseSharedResponse = context.mocks.deferred<void>();
    const locationAssign = context.mocks.browser.locationAssign();
    context.mocks.api(
      artifactCatalogContract.list,
      async ({ query, respond }) => {
        if (query.kind === "shared-thread") {
          sharedRequestStarted.resolve();
          await releaseSharedResponse.promise;
          return respond(200, {
            artifacts: [
              artifact({
                kind: "shared-thread",
                title: "Weekly launch review",
              }),
            ],
            nextCursor: null,
          });
        }
        return respond(200, {
          artifacts: [artifact({ kind: "presentation", title: "launch-deck" })],
          nextCursor: null,
        });
      },
    );
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...artifact({
          kind: "shared-thread",
          title: "Weekly launch review",
        }),
        kind: "shared-thread",
        sharedThread: { id: "b0000000-0000-4000-a000-000000000001" },
      });
    });

    setupArtifactCatalogPage();
    await findCard("launch-deck");

    const sharedConversationFilter = buttonByLabel(
      "Show shared conversation artifacts",
    );
    if (!sharedConversationFilter) {
      throw new Error("Expected a shared conversation kind filter");
    }
    click(sharedConversationFilter);
    await sharedRequestStarted.promise;

    expect(screen.getByLabelText("Loading artifacts")).toBeInTheDocument();

    await act(async () => {
      releaseSharedResponse.resolve();
      await releaseSharedResponse.promise;
    });

    const row = await findCard("Weekly launch review");
    const listItem = row.closest("li");
    if (!listItem) {
      throw new Error("Expected a shared conversation list item");
    }
    expect(row).toHaveRole("button");
    expect(listItem).toHaveRole("listitem");
    expect(listItem.parentElement).toHaveRole("list");

    click(row);
    await waitFor(() => {
      expect(locationAssign.calls).toStrictEqual([
        "/share/threads/b0000000-0000-4000-a000-000000000001",
      ]);
    });
  });

  it("localizes the catalog and filters without changing artifact titles", async () => {
    document.documentElement.lang = "pt-BR";
    const requestedKinds: (string | undefined)[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      requestedKinds.push(query.kind);
      return respond(200, {
        artifacts: [
          artifact({
            kind: query.kind === "image" ? "image" : "presentation",
            title: query.kind === "image" ? "generated.png" : "launch-deck",
          }),
        ],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();

    await findCard("launch-deck");
    await expect(
      screen.findByRole("heading", { name: "Artefatos" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByLabelText("Filtros de tipo de artefato").textContent,
    ).toContain("Apresentações");
    expect(
      queryAllByRoleFast(
        "button",
        screen.getByLabelText("Filtros de tipo de artefato"),
      ).map((button) => {
        return button.textContent;
      }),
    ).toStrictEqual([
      "Apresentações",
      "Sites",
      "Imagens",
      "Vídeos",
      "Avatares",
      "Conversas compartilhadas",
      "Arquivos",
    ]);

    const imageFilter = buttonByLabel("Mostrar artefatos de imagem");
    if (!imageFilter) {
      throw new Error("Expected a localized image kind filter");
    }
    await click(imageFilter);

    await findCard("generated.png");
    expect(requestedKinds).toStrictEqual(["presentation", "image"]);
  });

  it("renders generic file artwork when a card has no thumbnail", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ title: "quarterly-report.pdf" })],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();

    const card = await findCard("quarterly-report.pdf");
    expect(card.querySelector("img")).toBeNull();
    expect(
      screen.getByTestId("artifact-catalog-file-preview-icon"),
    ).toBeInTheDocument();
    expect(screen.getByText("PDF")).toBeInTheDocument();
  });

  it("falls back when a thumbnail fails to load", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [
          artifact({
            kind: "image",
            title: "broken-preview.png",
            thumbnail: {
              url: "https://cdn.vm0.io/artifacts/test/broken-preview.png",
            },
          }),
        ],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();

    const card = await findCard("broken-preview.png");
    const thumbnail = card.querySelector(
      '[data-testid="artifact-catalog-thumbnail"]',
    );
    expect(thumbnail).toBeInTheDocument();

    fireEvent.error(thumbnail!);

    await waitFor(() => {
      expect(thumbnail).toHaveClass("hidden");
      expect(
        screen.getByTestId("artifact-catalog-file-preview-icon"),
      ).toBeInTheDocument();
    });
  });

  it("appends the next page when the list is scrolled to the end", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      if (query.cursor === "cursor-2") {
        return respond(200, {
          artifacts: [
            artifact({
              id: "a0000000-0000-4000-a000-000000000002",
              title: "second-page.txt",
            }),
          ],
          nextCursor: null,
        });
      }
      return respond(200, {
        artifacts: [artifact({ title: "first-page.txt" })],
        nextCursor: "cursor-2",
      });
    });

    setupArtifactCatalogPage();
    await findCard("first-page.txt");

    const viewport = document.querySelector("main");
    if (!viewport) {
      throw new Error("Expected the artifacts page to render a scroll region");
    }
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));

    await findCard("second-page.txt");
    expect(buttonByLabel("Preview first-page.txt")).toBeInTheDocument();
  });

  it("prefetches the next page within two viewport heights of the end", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      if (query.cursor === "cursor-2") {
        return respond(200, {
          artifacts: [
            artifact({
              id: "a0000000-0000-4000-a000-000000000002",
              title: "prefetched-page.txt",
            }),
          ],
          nextCursor: null,
        });
      }
      return respond(200, {
        artifacts: [artifact({ title: "first-page.txt" })],
        nextCursor: "cursor-2",
      });
    });

    setupArtifactCatalogPage();
    await findCard("first-page.txt");

    const viewport = document.querySelector("main");
    if (!viewport) {
      throw new Error("Expected the artifacts page to render a scroll region");
    }
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 1000 },
      scrollHeight: { configurable: true, value: 5000 },
      scrollTop: { configurable: true, value: 2200 },
    });
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));

    await expect(findCard("prefetched-page.txt")).resolves.toBeInTheDocument();
  });

  it("discards an in-flight page after the kind changes", async () => {
    const secondPageStarted = context.mocks.deferred<void>();
    const releaseSecondPage = context.mocks.deferred<void>();
    context.mocks.api(
      artifactCatalogContract.list,
      async ({ query, respond }) => {
        if (query.cursor === "all-next") {
          secondPageStarted.resolve();
          await releaseSecondPage.promise;
          return respond(200, {
            artifacts: [
              artifact({
                id: "a0000000-0000-4000-a000-000000000002",
                title: "stale-file.txt",
              }),
            ],
            nextCursor: null,
          });
        }
        if (query.kind === "image") {
          return respond(200, {
            artifacts: [
              artifact({
                id: "a0000000-0000-4000-a000-000000000003",
                kind: "image",
                title: "fresh-image.png",
              }),
            ],
            nextCursor: null,
          });
        }
        return respond(200, {
          artifacts: [artifact({ title: "first-page.txt" })],
          nextCursor: "all-next",
        });
      },
    );

    setupArtifactCatalogPage();
    await findCard("first-page.txt");
    const viewport = document.querySelector("main");
    if (!viewport) {
      throw new Error("Expected the artifacts page to render a scroll region");
    }
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await secondPageStarted.promise;

    const imageFilter = buttonByLabel("Show image artifacts");
    if (!imageFilter) {
      throw new Error("Expected an image kind filter");
    }
    await click(imageFilter);
    await findCard("fresh-image.png");

    await act(async () => {
      releaseSecondPage.resolve();
      await releaseSecondPage.promise;
    });

    expect(buttonByLabel("Preview stale-file.txt")).toBeUndefined();
    expect(buttonByLabel("Preview fresh-image.png")).toBeInTheDocument();
  });

  it("retries a cursor after the previous page request fails", async () => {
    const failedPageStarted = context.mocks.deferred<void>();
    const releaseFailedPage = context.mocks.deferred<void>();
    let nextPageAttempts = 0;
    context.mocks.api(
      artifactCatalogContract.list,
      async ({ query, respond }) => {
        if (query.cursor !== "retry-next") {
          return respond(200, {
            artifacts: [artifact({ title: "first-page.txt" })],
            nextCursor: "retry-next",
          });
        }
        nextPageAttempts += 1;
        if (nextPageAttempts === 1) {
          failedPageStarted.resolve();
          await releaseFailedPage.promise;
          return respond(403, {
            error: {
              code: "FORBIDDEN",
              message: "Transient catalog failure",
            },
          });
        }
        return respond(200, {
          artifacts: [
            artifact({
              id: "a0000000-0000-4000-a000-000000000002",
              title: "retried-page.txt",
            }),
          ],
          nextCursor: null,
        });
      },
    );

    setupArtifactCatalogPage();
    await findCard("first-page.txt");
    const viewport = document.querySelector("main");
    if (!viewport) {
      throw new Error("Expected the artifacts page to render a scroll region");
    }
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
    await failedPageStarted.promise;
    await act(async () => {
      releaseFailedPage.resolve();
      await releaseFailedPage.promise;
    });

    viewport.dispatchEvent(new Event("scroll", { bubbles: true }));

    await findCard("retried-page.txt");
    expect(nextPageAttempts).toBe(2);
  });

  it("loads the kind detail only after a card is opened", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ title: "launch-plan.txt" })],
        nextCursor: null,
      });
    });
    const detailRequests: string[] = [];
    context.mocks.http.get(
      "https://artifacts.example.com/launch-plan.txt",
      () => {
        return HttpResponse.text("launch plan");
      },
    );
    context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
      detailRequests.push(params.artifactId);
      return respond(200, {
        ...artifact({ title: "launch-plan.txt" }),
        kind: "file",
        file: {
          id: "f0000000-0000-4000-a000-000000000001",
          filename: "launch-plan.txt",
          contentType: "text/plain",
          size: 1024,
          url: "https://artifacts.example.com/launch-plan.txt",
          previewImageUrl: null,
        },
      });
    });

    setupArtifactCatalogPage();
    const card = await findCard("launch-plan.txt");
    expect(detailRequests).toStrictEqual([]);

    await click(card);

    await waitFor(() => {
      expect(detailRequests).toStrictEqual([
        "a0000000-0000-4000-a000-000000000001",
      ]);
    });
    await expect(screen.findByText("launch plan")).resolves.toBeInTheDocument();
  });

  it("opens an avatar artifact as a video preview", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ kind: "avatar", title: "avatar-video.mp4" })],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...artifact({ kind: "avatar", title: "avatar-video.mp4" }),
        kind: "avatar",
        file: {
          id: "f0000000-0000-4000-a000-000000000004",
          filename: "avatar-video.mp4",
          contentType: "video/mp4",
          size: 4096,
          url: "https://artifacts.example.com/avatar-video.mp4",
          previewImageUrl: null,
        },
        model: "joggai-talking-avatar",
        durationSeconds: 12,
      });
    });

    setupArtifactCatalogPage();
    await click(await findCard("avatar-video.mp4"));

    await expect(
      screen.findByLabelText("Video preview for avatar-video.mp4"),
    ).resolves.toHaveAttribute(
      "src",
      "https://artifacts.example.com/avatar-video.mp4",
    );
  });

  it("downloads a generic binary when its card is opened", async () => {
    const browser = context.mocks.browser.blobDownload();
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ title: "release-bundle.zip" })],
        nextCursor: null,
      });
    });
    context.mocks.http.get(
      "https://artifacts.example.com/release-bundle.zip",
      () => {
        return HttpResponse.text("archive bytes", {
          headers: { "Content-Type": "application/zip" },
        });
      },
    );
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...artifact({ title: "release-bundle.zip" }),
        kind: "file",
        file: {
          id: "f0000000-0000-4000-a000-000000000002",
          filename: "release-bundle.zip",
          contentType: "application/zip",
          size: 2048,
          url: "https://artifacts.example.com/release-bundle.zip",
          previewImageUrl: null,
        },
      });
    });

    setupArtifactCatalogPage();
    await click(await findCard("release-bundle.zip"));

    await waitFor(() => {
      expect(browser.downloads).toHaveLength(1);
    });
    expect(browser.downloads[0]).toMatchObject({
      filename: "release-bundle.zip",
      blob: expect.any(Blob),
    });
  });

  it("shows the empty state when the catalog has no artifacts", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [], nextCursor: null });
    });

    setupArtifactCatalogPage();

    await expect(
      screen.findByText("No artifacts found"),
    ).resolves.toBeInTheDocument();
  });

  it("announces an alert when the catalog fails to load", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Transient catalog failure" },
      });
    });

    setupArtifactCatalogPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not load artifacts. Try again later.",
    );
  });
});
