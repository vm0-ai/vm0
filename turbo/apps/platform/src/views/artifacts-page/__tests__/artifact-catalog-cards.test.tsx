import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Artifact cards identify their kind and show available previews", async () => {
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

  await setupArtifactCatalogPage(context);

  await expect(
    findArtifactAction("launch-plan.txt"),
  ).resolves.toBeInTheDocument();
  const siteCard = await findArtifactAction("launch-site");
  const avatarCard = await findArtifactAction("avatar-video.mp4");

  expect(
    within(siteCard).getByLabelText("Hosted site artifact"),
  ).toBeInTheDocument();
  expect(
    within(avatarCard).getByLabelText("Avatar artifact"),
  ).toBeInTheDocument();
  expect(siteCard.querySelector("img")).toHaveAttribute(
    "src",
    "https://cdn.vm0.io/cdn-cgi/image/width=640,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/test/preview.webp",
  );
});

test("A video artifact without a poster uses its source as the catalog preview", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          kind: "video",
          title: "product-tour.mp4",
          videoSourceUrl: "https://videos.example.test/product-tour.mp4",
        }),
      ],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=video" });

  const card = await findArtifactAction("product-tour.mp4");
  expect(
    within(card).getByTestId("artifact-catalog-video-source"),
  ).toHaveAttribute(
    "src",
    "https://videos.example.test/product-tour.mp4#t=0.001",
  );
});

test("Artifact catalog failure is announced clearly", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Transient catalog failure" },
    });
  });

  await setupArtifactCatalogPage(context);

  await expect(
    screen.findByLabelText("Artifact kind filters"),
  ).resolves.toBeInTheDocument();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not load artifacts. Try again later.");
});

test("An empty artifact catalog shows an explicit empty state", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const filters = await screen.findByLabelText("Artifact kind filters");
  expect(getButtonByName("Show file artifacts", filters)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    screen.findByText("No artifacts found"),
  ).resolves.toBeInTheDocument();
});

test("The artifact catalog localizes navigation without changing artifact names", async () => {
  context.mocks.data.userPreferences({ locale: "pt-BR" });
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
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

  await setupArtifactCatalogPage(context);

  await expect(
    screen.findByRole("heading", { name: "Artefatos" }),
  ).resolves.toBeInTheDocument();
  await expect(findArtifactAction("launch-deck")).resolves.toBeInTheDocument();
  const filters = screen.getByLabelText("Filtros de tipo de artefato");
  expect(
    queryAllByRoleFast("button", filters).map((button) => {
      return button.textContent?.trim();
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

  click(getButtonByName("Mostrar artefatos de imagem", filters));

  await expect(
    findArtifactAction("generated.png"),
  ).resolves.toBeInTheDocument();
});

test("Missing or broken thumbnails fall back to recognizable file artwork", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
    if (query.kind === "image") {
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
    }
    return respond(200, {
      artifacts: [artifact({ title: "quarterly-report.pdf" })],
      nextCursor: null,
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const pdfCard = await findArtifactAction("quarterly-report.pdf");
  expect(
    within(pdfCard).getByTestId("artifact-catalog-file-preview-icon"),
  ).toBeInTheDocument();
  expect(within(pdfCard).getByText("PDF")).toBeInTheDocument();
  expect(pdfCard.querySelector("img")).toBeNull();

  const filters = screen.getByLabelText("Artifact kind filters");
  click(getButtonByName("Show image artifacts", filters));
  const imageCard = await findArtifactAction("broken-preview.png");
  const thumbnail = within(imageCard).getByTestId("artifact-catalog-thumbnail");

  fireEvent.error(thumbnail);

  await waitFor(() => {
    expect(thumbnail).toHaveClass("hidden");
    expect(
      within(imageCard).getByTestId("artifact-catalog-file-preview-icon"),
    ).toBeInTheDocument();
  });
});
