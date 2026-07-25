import { screen, waitFor } from "@testing-library/react";
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
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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

function setupArtifactCatalogPage(): void {
  detachedSetupPage({
    context,
    path: "/artifacts",
    user: { id: CATALOG_USER_ID, fullName: "Test User" },
    org: {
      activeOrg: { id: CATALOG_ORG_ID, name: "Test Org" },
      memberships: [{ id: CATALOG_ORG_ID }],
    },
    featureSwitches: {
      [FeatureSwitchKey.Artifacts]: true,
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
  it("renders the first page of artifacts with their kind", async () => {
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [
          artifact({ title: "launch-plan.txt" }),
          artifact({
            id: "a0000000-0000-4000-a000-000000000002",
            kind: "hosted-site",
            title: "launch-site",
            thumbnail: { url: "https://cdn.example.com/preview.webp" },
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
      "https://cdn.example.com/preview.webp",
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
