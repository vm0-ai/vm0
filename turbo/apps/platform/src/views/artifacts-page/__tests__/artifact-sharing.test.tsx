import { hostContract } from "@okouai/api-contracts/contracts/host";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  setupPage,
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
function queryAction(role: "button" | "menuitem", name: string) {
  return queryAllByRoleFast(role).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
}
function action(role: "button" | "menuitem", name: string): HTMLElement {
  const element = queryAction(role, name);
  if (!element) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return element;
}

const deploymentId = "00000000-0000-4000-8000-000000000009";
const shareId = "00000000-0000-4000-8000-000000000010";
const canonical = `http://localhost/api/host/private-deployments/${deploymentId}/view`;
const organizationUrl = `https://app.okou.ai/share/artifacts/${shareId}`;
const publicUrl = `https://sh-${shareId.replaceAll("-", "")}-${"b".repeat(24)}.okou.app/`;

async function openArtifact(enabled = true) {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ kind: "hosted-site", title: "Private report" })],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ kind: "hosted-site", title: "Private report" }),
      kind: "hosted-site",
      site: {
        id: "00000000-0000-4000-8000-000000000008",
        slug: "private-report",
        publicSlug: "private-report",
        url: canonical,
        deploymentVersion: 2,
        entrypoint: "/index.html",
        spaFallback: true,
      },
    });
  });
  context.mocks.api(hostContract.privatePreview, ({ respond }) => {
    return respond(200, {
      url: `https://pv-${"a".repeat(48)}.okou.app/`,
      expiresAt: "2099-01-01T00:00:00Z",
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: enabled },
  });
  click(await findArtifactAction("Private report"));
  await screen.findByTestId("artifact-dialog-site-frame");
}

test("Share menu only publishes on explicit actions and can copy, change audience and stop", async () => {
  let status: ArtifactShareStatus = {
    shareId: null,
    audience: "private",
    organization: { id: "original-org", name: "Original organization" },
    selectedTarget: null,
    selectedVersion: null,
    candidateVersion: 2,
    url: null,
  };
  const changes: string[] = [];
  let reads = 0;
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    reads++;
    return respond(200, status);
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    expect(body.target).toStrictEqual({ kind: "html", id: deploymentId });
    changes.push(body.audience);
    status = {
      ...status,
      shareId,
      audience: body.audience,
      selectedTarget: body.target,
      selectedVersion: 2,
      url:
        body.audience === "organization"
          ? organizationUrl
          : body.audience === "public"
            ? publicUrl
            : null,
    };
    return respond(200, status);
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openArtifact();
  expect(reads).toBe(0);
  const open = async () => {
    await waitFor(() => {
      return expect(queryAction("button", "Share")).toBeDefined();
    });
    click(action("button", "Share"));
    await screen.findByText("Original organization");
    await waitFor(() => {
      return expect(
        action("menuitem", "Share to organization"),
      ).not.toHaveAttribute("aria-disabled", "true");
    });
  };
  await open();
  expect(changes).toStrictEqual([]);
  expect(action("menuitem", "Copy existing link")).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  click(action("menuitem", "Share to organization"));
  await waitFor(() => {
    return expect(changes).toStrictEqual(["organization"]);
  });
  await open();
  click(action("menuitem", "Copy existing link"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([organizationUrl]);
  });
  expect(changes).toStrictEqual(["organization"]);
  await open();
  click(action("menuitem", "Share to Public"));
  await waitFor(() => {
    return expect(changes).toStrictEqual(["organization", "public"]);
  });
  await open();
  click(action("menuitem", "Stop sharing"));
  await waitFor(() => {
    return expect(changes).toStrictEqual(["organization", "public", "private"]);
  });
});

test("the shared rollout switch keeps the private share menu hidden", async () => {
  await openArtifact(false);
  expect(queryAction("button", "Share")).toBeUndefined();
  expect(queryAction("menuitem", "Share to Public")).toBeUndefined();
});

test("an authorized organization link navigates straight to isolated content with no viewer", async () => {
  const redirect = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  const temporary = `https://ps-${"c".repeat(48)}.okou.app/`;
  context.mocks.api(artifactSharesContract.resolve, ({ respond }) => {
    return respond(200, { url: temporary, expiresAt: "2099-01-01T00:00:00Z" });
  });
  await startPage({
    context,
    path: `/share/artifacts/${shareId}`,
    host: "app.okou.ai",
  });
  await waitFor(() => {
    return expect(redirect).toHaveBeenCalledWith(temporary);
  });
  expect(document.querySelector("iframe")).toBeNull();
});

test("denied links display no artifact metadata or content", async () => {
  context.mocks.api(artifactSharesContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await setupPage({
    context,
    path: `/share/artifacts/${shareId}`,
    host: "app.okou.ai",
  });
  expect(
    screen.getByText("This artifact is unavailable or you do not have access."),
  ).toBeInTheDocument();
  expect(document.querySelector("iframe")).toBeNull();
});

test("logged-out recipients use the existing login with a same-origin artifact return URL", async () => {
  const redirect = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  let resolves = 0;
  context.mocks.api(artifactSharesContract.resolve, ({ respond }) => {
    resolves++;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await startPage({
    context,
    path: `/share/artifacts/${shareId}?redirect_url=https://attacker.example`,
    host: "app.okou.ai",
    auth: null,
  });
  await waitFor(() => {
    return expect(redirect).toHaveBeenCalledWith(expect.any(String));
  });
  const destination = String(redirect.mock.calls[0]?.[0]);
  expect(destination).toContain("sign-in");
  expect(decodeURIComponent(destination)).toContain(
    `/share/artifacts/${shareId}`,
  );
  expect(destination).not.toContain("attacker.example");
  expect(resolves).toBe(0);
});
