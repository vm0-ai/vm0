import { hostContract } from "@okouai/api-contracts/contracts/host";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("Opening an avatar artifact plays its video preview", async () => {
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

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=avatar" });

  const avatar = await findArtifactAction("avatar-video.mp4");
  click(avatar);

  await expect(
    screen.findByLabelText("Video preview for avatar-video.mp4"),
  ).resolves.toHaveAttribute(
    "src",
    "https://artifacts.example.com/avatar-video.mp4",
  );
});

test("Opening an unpreviewable binary downloads it with the correct filename", async () => {
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

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const archive = await findArtifactAction("release-bundle.zip");
  click(archive);

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toMatchObject({
    filename: "release-bundle.zip",
    url: "https://artifacts.example.com/release-bundle.zip",
  });
});

test("Opening a text artifact shows its content on demand", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "launch-plan.txt" })],
      nextCursor: null,
    });
  });
  context.mocks.http.get(
    "https://artifacts.example.com/launch-plan.txt",
    () => {
      return HttpResponse.text("launch plan");
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
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

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const textArtifact = await findArtifactAction("launch-plan.txt");
  expect(screen.queryByText("launch plan")).not.toBeInTheDocument();
  click(textArtifact);

  await expect(screen.findByText("launch plan")).resolves.toBeInTheDocument();
});

test.each(["hosted-site", "presentation"] as const)(
  "Opening a private %s uses an authorized isolated origin",
  async (kind) => {
    const canonical =
      "http://localhost/api/host/private-deployments/00000000-0000-4000-8000-000000000009/view";
    const preview = `https://pv-${"a".repeat(48)}.sites.vm7.io/`;
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ kind, title: "Private report" })],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...artifact({ kind, title: "Private report" }),
        kind,
        site: {
          id: "00000000-0000-4000-8000-000000000008",
          slug: "private-report",
          publicSlug: "private-report",
          url: canonical,
          deploymentVersion: 1,
          entrypoint: "/index.html",
          spaFallback: false,
        },
      });
    });
    context.mocks.api(hostContract.privatePreview, ({ respond }) => {
      return respond(200, {
        url: preview,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    });
    await setupArtifactCatalogPage(context);
    click(await findArtifactAction("Private report"));
    await waitFor(() => {
      const view = screen.getByTestId("artifact-dialog-site-frame");
      const frame =
        view instanceof HTMLIFrameElement ? view : view.querySelector("iframe");
      expect(frame).toHaveAttribute("src", preview);
    });
  },
);
