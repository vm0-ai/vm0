import { act, screen, waitFor } from "@testing-library/react";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const CATALOG_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
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

function setupArtifactCatalogPage(enabled = true): void {
  detachedSetupPage({
    context,
    path: "/artifacts",
    user: { id: CATALOG_USER_ID, fullName: "Test User" },
    org: {
      activeOrg: { id: CATALOG_ORG_ID, name: "Test Org" },
      memberships: [{ id: CATALOG_ORG_ID }],
    },
    featureSwitches: {
      [FeatureSwitchKey.Artifacts]: enabled,
    },
  });
}

function buttonByLabel(label: string): HTMLElement | undefined {
  return queryAllByRoleFast("button").find((element) => {
    return element.getAttribute("aria-label") === label;
  });
}

async function findCard(title: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const card = buttonByLabel(`Preview ${title}`);
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
    expect(site.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.vm0.io/cdn-cgi/image/width=640,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/test/preview.webp",
    );
  });

  it("asks the server for one kind when a filter is selected", async () => {
    const requestedKinds: (string | undefined)[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      requestedKinds.push(query.kind);
      return respond(200, {
        artifacts: [
          artifact({
            kind: query.kind === "image" ? "image" : "file",
            title: query.kind === "image" ? "generated.png" : "notes.txt",
          }),
        ],
        nextCursor: null,
      });
    });

    setupArtifactCatalogPage();
    await findCard("notes.txt");

    const imageFilter = buttonByLabel("Show image artifacts");
    if (!imageFilter) {
      throw new Error("Expected an image kind filter");
    }
    await click(imageFilter);

    await findCard("generated.png");
    expect(requestedKinds).toStrictEqual([undefined, "image"]);
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

  it("reloads the same artifact detail after a realtime catalog change", async () => {
    const browser = context.mocks.browser.blobDownload();
    let listRequests = 0;
    const detailRequests: string[] = [];
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      listRequests += 1;
      return respond(200, {
        artifacts: [artifact({ title: "changing.bin" })],
        nextCursor: null,
      });
    });
    context.mocks.http.get("https://artifacts.example.com/changing.bin", () => {
      return HttpResponse.text("binary");
    });
    context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
      detailRequests.push(params.artifactId);
      return respond(200, {
        ...artifact({ title: "changing.bin" }),
        kind: "file",
        file: {
          id: "f0000000-0000-4000-a000-000000000003",
          filename: "changing.bin",
          contentType: "application/octet-stream",
          size: 512,
          url: "https://artifacts.example.com/changing.bin",
          previewImageUrl: null,
        },
      });
    });

    setupArtifactCatalogPage();
    const card = await findCard("changing.bin");
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("artifactCatalogChanged"),
      ).toBeTruthy();
    });

    await click(card);
    await waitFor(() => {
      expect(detailRequests).toHaveLength(1);
      expect(browser.downloads).toHaveLength(1);
    });

    context.mocks.ably.trigger("artifactCatalogChanged");
    await waitFor(() => {
      expect(listRequests).toBeGreaterThanOrEqual(2);
    });

    await click(await findCard("changing.bin"));
    await waitFor(() => {
      expect(detailRequests).toHaveLength(2);
      expect(browser.downloads).toHaveLength(2);
    });
  });

  it("hides the entry, redirects, and skips the list when disabled", async () => {
    let requested = false;
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      requested = true;
      return respond(200, { artifacts: [], nextCursor: null });
    });

    setupArtifactCatalogPage(false);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${CATALOG_AGENT_ID}/chat`);
    });
    expect(requested).toBeFalsy();
    expect(
      queryAllByRoleFast("link").some((link) => {
        return link.textContent === "Artifacts";
      }),
    ).toBeFalsy();
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
});
