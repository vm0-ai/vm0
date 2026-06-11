import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

async function openGeneralTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=general" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
  });
}

describe("organization general settings", () => {
  it("lets admins save or discard workspace profile edits", async () => {
    let capturedBody: unknown = null;
    const logoUrl = "https://cdn.vm0.test/orgs/old-slug/logo.png";
    context.mocks.data.org({
      id: "org_1",
      name: "Old Name",
      slug: "old-slug",
      role: "admin",
    });
    context.mocks.http.get("*/api/zero/org/logo", () => {
      return new Response(JSON.stringify({ logoUrl }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.api(zeroOrgContract.update, ({ body, respond }) => {
      capturedBody = body;
      return respond(200, {
        id: "org_1",
        name: "New Name",
        slug: "new-slug",
        role: "admin",
      });
    });

    await openGeneralTab();

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "old-slug" })).toHaveAttribute(
        "src",
        logoUrl,
      );
    });

    await fill(await screen.findByDisplayValue("Old Name"), "New Name");
    await fill(screen.getByDisplayValue("old-slug"), "new-slug");
    expect(screen.getByText("Save changes")).toBeInTheDocument();
    expect(screen.getByText("Discard")).toBeInTheDocument();

    click(screen.getByText("Discard"));
    expect(screen.getByDisplayValue("Old Name")).toBeInTheDocument();
    expect(screen.getByDisplayValue("old-slug")).toBeInTheDocument();

    await fill(screen.getByDisplayValue("Old Name"), "New Name");
    await fill(screen.getByDisplayValue("old-slug"), "new-slug");
    click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(capturedBody).toStrictEqual({
        name: "New Name",
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("uploads a workspace logo after validating image dimensions", async () => {
    const user = userEvent.setup({ delay: null });
    let capturedLogoName: string | null = null;
    const initialLogoUrl = "https://cdn.vm0.test/orgs/acme/logo-old.png";
    const uploadedLogoUrl = "https://cdn.vm0.test/orgs/acme/logo-new.png";
    context.mocks.browser.imageDimensions({ width: 512, height: 512 });
    context.mocks.data.org({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      role: "admin",
    });
    context.mocks.http.get("*/api/zero/org/logo", () => {
      return new Response(JSON.stringify({ logoUrl: initialLogoUrl }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.http.post("*/api/zero/org/logo", async ({ request }) => {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new Error("Uploaded logo file not found");
      }
      capturedLogoName = file.name;
      return new Response(JSON.stringify({ logoUrl: uploadedLogoUrl }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    await openGeneralTab();

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "acme" })).toHaveAttribute(
        "src",
        initialLogoUrl,
      );
    });

    await user.upload(
      screen.getByLabelText("Upload logo"),
      new File(["logo"], "workspace-logo.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Save changes")).toBeInTheDocument();
    });

    click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(capturedLogoName).toBe("workspace-logo.png");
      expect(screen.getByRole("img", { name: "acme" })).toHaveAttribute(
        "src",
        uploadedLogoUrl,
      );
      expect(screen.getByText("Workspace updated")).toBeInTheDocument();
    });
  });

  it("rejects workspace logos outside the supported dimensions", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.imageDimensions([
      null,
      { width: 80, height: 80 },
      { width: 5000, height: 5000 },
    ]);
    context.mocks.data.org({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      role: "admin",
    });

    await openGeneralTab();

    const uploadInput = screen.getByLabelText("Upload logo");
    await user.upload(
      uploadInput,
      new File(["not-image"], "unreadable.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(screen.getByText("Could not read image file")).toBeInTheDocument();
      expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    });

    await user.upload(
      uploadInput,
      new File(["small"], "too-small.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Logo is too small/u)).toBeInTheDocument();
      expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    });

    await user.upload(
      uploadInput,
      new File(["large"], "too-large.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(screen.getByText(/Logo is too large/u)).toBeInTheDocument();
      expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    });
  });
});
