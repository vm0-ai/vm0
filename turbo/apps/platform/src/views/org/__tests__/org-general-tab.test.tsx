import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { refreshOrg$ } from "../../../signals/org.ts";

const context = testContext();

function mockAPIs(overrides?: { slug?: string; name?: string; role?: string }) {
  const org = {
    id: "org_1",
    slug: overrides?.slug ?? "test-org",
    name: overrides?.name ?? "Test Org",
    role: overrides?.role ?? "admin",
  };
  server.use(
    http.get("*/api/zero/org", () => {
      return HttpResponse.json(org);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/org/logo", () => {
      return HttpResponse.json({ logoUrl: null });
    }),
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
  );
  return org;
}

async function openGeneralTab() {
  detachedSetupPage({ context, path: "/?settings=general" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org general tab - display", () => {
  // ORG-D-008
  it("logo preview image is displayed", async () => {
    mockAPIs({ slug: "my-org" });
    server.use(
      http.get("*/api/zero/org/logo", () => {
        return HttpResponse.json({ logoUrl: "https://example.com/logo.png" });
      }),
    );
    await openGeneralTab();
    const logo = await screen.findByAltText("my-org");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "https://example.com/logo.png");
  });

  // ORG-D-009
  it("organization name is displayed", async () => {
    mockAPIs({ name: "Acme Corp" });
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Acme Corp");
    expect(nameInput).toBeInTheDocument();
  });

  // ORG-D-010
  it("organization slug is displayed", async () => {
    mockAPIs({ slug: "acme-corp" });
    await openGeneralTab();
    const slugInput = await screen.findByDisplayValue("acme-corp");
    expect(slugInput).toBeInTheDocument();
  });

  // ORG-D-011
  it("loading skeletons are shown while data loads", async () => {
    // First load org so the dialog opens normally
    mockAPIs({ slug: "test-org" });
    await openGeneralTab();
    // Wait for content to be rendered
    await screen.findByDisplayValue("test-org");

    // Now trigger a refresh with a slow (deferred) org response
    const orgDeferred = createDeferredPromise<Response>(context.signal);
    server.use(
      http.get("*/api/zero/org", () => {
        return orgDeferred.promise;
      }),
    );
    context.store.set(refreshOrg$);

    // While org is reloading, the skeleton should be shown
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("Workspace name"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("status", { name: "Loading" }),
      ).toBeInTheDocument();
    });

    // Resolve deferred to allow clean teardown
    orgDeferred.resolve(
      HttpResponse.json({
        id: "org_1",
        slug: "test-org",
        name: "Test Org",
        role: "admin",
      }) as unknown as Response,
    );
  });

  // ORG-D-012
  it("error messages shown during save failure", async () => {
    const user = userEvent.setup();
    mockAPIs({ slug: "old-slug" });
    server.use(
      http.put("*/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Slug already taken", code: "CONFLICT" } },
          { status: 409 },
        );
      }),
    );
    await openGeneralTab();
    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "taken-slug");
    await user.click(screen.getByText("Save changes"));
    await waitFor(() => {
      expect(screen.getByText("Slug already taken")).toBeInTheDocument();
    });
  });

  // ORG-D-013
  it("logo upload preview is shown after selecting a file", async () => {
    const user = userEvent.setup();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-preview");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    mockAPIs({ slug: "test-org" });
    await openGeneralTab();
    // Wait for admin inputs to load
    await screen.findByDisplayValue("Test Org");
    const fileInput = screen.getByLabelText("Upload logo");
    const file = new File(["img"], "logo.png", { type: "image/png" });
    await user.upload(fileInput, file);
    await waitFor(() => {
      const img = screen.getByAltText("test-org");
      expect(img).toHaveAttribute("src", "blob:mock-preview");
    });
  });
});

describe("org general tab - interaction", () => {
  // ORG-I-015
  it("name input field is editable", async () => {
    mockAPIs({ name: "Old Name" });
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Old Name");
    await fill(nameInput, "New Name");
    expect(screen.getByDisplayValue("New Name")).toBeInTheDocument();
  });

  // ORG-I-016
  it("slug input field is editable", async () => {
    mockAPIs({ slug: "old-slug" });
    await openGeneralTab();
    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "new-slug");
    expect(screen.getByDisplayValue("new-slug")).toBeInTheDocument();
  });

  // ORG-I-017
  it("save changes button submits form", async () => {
    const user = userEvent.setup();
    const requestBody = vi.fn();
    mockAPIs({ name: "Old Name", slug: "test-org" });
    server.use(
      http.put("*/api/zero/org", async ({ request }) => {
        requestBody(await request.json());
        // After a successful save, update the GET handler to return the new name
        // so the org refresh reflects the change and hasChanges becomes false
        server.use(
          http.get("*/api/zero/org", () => {
            return HttpResponse.json({
              id: "org_1",
              slug: "test-org",
              name: "New Name",
              role: "admin",
            });
          }),
        );
        return HttpResponse.json({
          id: "org_1",
          slug: "test-org",
          name: "New Name",
        });
      }),
    );
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Old Name");
    await fill(nameInput, "New Name");
    await user.click(screen.getByText("Save changes"));
    await waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({ name: "New Name" });
      // After a successful save the unsaved-changes toolbar disappears
      expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    });
  });

  // ORG-I-018
  it("discard button reverts changes", async () => {
    const user = userEvent.setup();
    mockAPIs({ name: "Original Name" });
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Original Name");
    await fill(nameInput, "Changed Name");
    expect(screen.getByDisplayValue("Changed Name")).toBeInTheDocument();
    await user.click(screen.getByText("Discard"));
    expect(screen.getByDisplayValue("Original Name")).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  // ORG-I-019
  it("leave workspace button opens confirmation dialog", async () => {
    const user = userEvent.setup();
    mockAPIs({ role: "member" });
    await openGeneralTab();
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Leave";
        }),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Leave";
      })!,
    );
    await waitFor(() => {
      expect(screen.getByText("Leave workspace?")).toBeInTheDocument();
    });
  });

  // ORG-I-020
  it("delete workspace button opens confirmation dialog requiring slug", async () => {
    const user = userEvent.setup();
    mockAPIs({ slug: "acme-org" });
    await openGeneralTab();
    // Wait for page to load
    await screen.findByDisplayValue("acme-org");
    const deleteButton = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Delete";
    });
    expect(deleteButton).toBeDefined();
    await user.click(deleteButton!);
    await waitFor(() => {
      expect(screen.getByText("Delete workspace?")).toBeInTheDocument();
    });
    // The dialog should contain an input with placeholder matching the slug
    const confirmInput = screen.getByPlaceholderText("acme-org");
    expect(confirmInput).toBeInTheDocument();
  });
});

describe("org general tab - validation", () => {
  it("delete workspace requires typing exact slug", async () => {
    const user = userEvent.setup();
    mockAPIs({ slug: "my-workspace" });
    await openGeneralTab();
    await screen.findByDisplayValue("my-workspace");
    const deleteWorkspaceBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Delete";
    });
    expect(deleteWorkspaceBtn).toBeDefined();
    await user.click(deleteWorkspaceBtn!);
    await waitFor(() => {
      expect(screen.getByText("Delete workspace?")).toBeInTheDocument();
    });
    // Get the destructive "Delete workspace" button inside the dialog footer
    const deleteBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Delete workspace";
    });
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn).toBeDisabled();
    // Type wrong slug — still disabled
    const confirmInput = screen.getByPlaceholderText("my-workspace");
    await user.type(confirmInput, "wrong-slug");
    expect(deleteBtn).toBeDisabled();
    // Fill correct slug — now enabled
    await fill(confirmInput, "my-workspace");
    expect(deleteBtn).not.toBeDisabled();
  });
});
