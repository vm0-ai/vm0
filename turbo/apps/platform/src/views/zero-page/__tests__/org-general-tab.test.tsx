import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockAPIs(overrides?: { slug?: string; name?: string; role?: string }) {
  const org = {
    id: "org_1",
    slug: overrides?.slug ?? "test-org",
    name: overrides?.name ?? "Test Org",
    role: overrides?.role ?? "admin",
  };
  server.use(
    http.get("*/api/zero/org", () => HttpResponse.json(org)),
    http.get("*/api/zero/chat-threads", () =>
      HttpResponse.json({ threads: [] }),
    ),
    http.get("*/api/zero/org/logo", () => HttpResponse.json({ logoUrl: null })),
    http.get("*/api/zero/team", () =>
      HttpResponse.json([
        {
          id: "mock-compose-id",
          name: "zero",
          displayName: null,
          description: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]),
    ),
  );
  return org;
}

async function openGeneralTab() {
  await setupPage({ context, path: "/?settings=general" });
  await waitFor(
    () => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    },
    { timeout: 3000 },
  );
}

describe("org general tab - profile section", () => {
  it("should show name and slug inputs for admin", async () => {
    mockAPIs({ name: "My Org", slug: "my-org" });
    await openGeneralTab();

    const nameInput = await screen.findByDisplayValue("My Org");
    expect(nameInput).toBeInTheDocument();

    const slugInput = await screen.findByDisplayValue("my-org");
    expect(slugInput).toBeInTheDocument();
  });

  it("should show name and slug as read-only text for non-admin", async () => {
    mockAPIs({ name: "My Org", slug: "my-org", role: "member" });
    await openGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("My Org")).toBeInTheDocument();
    });

    // Non-admin should see text, not inputs
    expect(screen.queryByDisplayValue("My Org")).not.toBeInTheDocument();
    expect(screen.getByText("my-org")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("my-org")).not.toBeInTheDocument();
  });

  it("should show save/discard buttons when slug is changed", async () => {
    mockAPIs({ slug: "old-slug" });
    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await act(() => {
      fireEvent.change(slugInput, { target: { value: "new-slug" } });
    });

    expect(screen.getByText("Save changes")).toBeInTheDocument();
    expect(screen.getByText("Discard")).toBeInTheDocument();
  });

  it("should discard slug changes when clicking Discard", async () => {
    mockAPIs({ slug: "original-slug" });
    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("original-slug");
    await act(() => {
      fireEvent.change(slugInput, { target: { value: "changed-slug" } });
    });

    expect(screen.getByDisplayValue("changed-slug")).toBeInTheDocument();

    await act(() => {
      fireEvent.click(screen.getByText("Discard"));
    });

    expect(screen.getByDisplayValue("original-slug")).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  it("should send slug in PUT request when saving slug change", async () => {
    const requestBody = vi.fn();
    mockAPIs({ name: "Test Org", slug: "old-slug" });
    server.use(
      http.put("*/api/zero/org", async ({ request }) => {
        requestBody(await request.json());
        return HttpResponse.json({
          id: "org_1",
          slug: "new-slug",
          name: "Test Org",
        });
      }),
    );

    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await act(() => {
      fireEvent.change(slugInput, { target: { value: "new-slug" } });
    });

    await act(() => {
      fireEvent.click(screen.getByText("Save changes"));
    });

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should send both name and slug when both are changed", async () => {
    const requestBody = vi.fn();
    mockAPIs({ name: "Old Name", slug: "old-slug" });
    server.use(
      http.put("*/api/zero/org", async ({ request }) => {
        requestBody(await request.json());
        return HttpResponse.json({
          id: "org_1",
          slug: "new-slug",
          name: "New Name",
        });
      }),
    );

    await openGeneralTab();

    const nameInput = await screen.findByDisplayValue("Old Name");
    const slugInput = screen.getByDisplayValue("old-slug");

    await act(() => {
      fireEvent.change(nameInput, { target: { value: "New Name" } });
      fireEvent.change(slugInput, { target: { value: "new-slug" } });
    });

    await act(() => {
      fireEvent.click(screen.getByText("Save changes"));
    });

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        name: "New Name",
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should show inline error when save fails", async () => {
    mockAPIs({ slug: "old-slug" });
    server.use(
      http.put("*/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Slug is already taken" } },
          { status: 409 },
        );
      }),
    );

    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await act(() => {
      fireEvent.change(slugInput, { target: { value: "taken-slug" } });
    });

    await act(() => {
      fireEvent.click(screen.getByText("Save changes"));
    });

    await waitFor(() => {
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });
  });

  it("should clear inline error on discard", async () => {
    mockAPIs({ slug: "old-slug" });
    server.use(
      http.put("*/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Slug is already taken" } },
          { status: 409 },
        );
      }),
    );

    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await act(() => {
      fireEvent.change(slugInput, { target: { value: "taken-slug" } });
    });

    await act(() => {
      fireEvent.click(screen.getByText("Save changes"));
    });

    await waitFor(() => {
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });

    await act(() => {
      fireEvent.click(screen.getByText("Discard"));
    });

    expect(screen.queryByText("Slug is already taken")).not.toBeInTheDocument();
  });

  it("should load and display logo for non-admin members", async () => {
    mockAPIs({ role: "member" });
    server.use(
      http.get("*/api/zero/org/logo", () => {
        return HttpResponse.json({
          logoUrl: "https://example.com/logo.png",
        });
      }),
    );

    await openGeneralTab();

    const logo = await screen.findByAltText("test-org");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "https://example.com/logo.png");
  });

  it("should not send slug when only name is changed", async () => {
    const requestBody = vi.fn();
    mockAPIs({ name: "Old Name", slug: "keep-slug" });
    server.use(
      http.put("*/api/zero/org", async ({ request }) => {
        requestBody(await request.json());
        return HttpResponse.json({
          id: "org_1",
          slug: "keep-slug",
          name: "New Name",
        });
      }),
    );

    await openGeneralTab();

    const nameInput = await screen.findByDisplayValue("Old Name");
    await act(() => {
      fireEvent.change(nameInput, { target: { value: "New Name" } });
    });

    await act(() => {
      fireEvent.click(screen.getByText("Save changes"));
    });

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({ name: "New Name" });
    });
  });
});
