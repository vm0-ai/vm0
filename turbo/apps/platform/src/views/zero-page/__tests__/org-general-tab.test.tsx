import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

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
    await fill(slugInput, "new-slug");

    expect(screen.getByText("Save changes")).toBeInTheDocument();
    expect(screen.getByText("Discard")).toBeInTheDocument();
  });

  it("should discard slug changes when clicking Discard", async () => {
    const user = userEvent.setup();
    mockAPIs({ slug: "original-slug" });
    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("original-slug");
    await fill(slugInput, "changed-slug");

    expect(screen.getByDisplayValue("changed-slug")).toBeInTheDocument();

    await user.click(screen.getByText("Discard"));

    expect(screen.getByDisplayValue("original-slug")).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  it("should send slug in PUT request when saving slug change", async () => {
    const user = userEvent.setup();
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
    await fill(slugInput, "new-slug");

    await user.click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should send both name and slug when both are changed", async () => {
    const user = userEvent.setup();
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

    await fill(nameInput, "New Name");
    await fill(slugInput, "new-slug");

    await user.click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        name: "New Name",
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should show inline error when save fails", async () => {
    const user = userEvent.setup();
    mockAPIs({ slug: "old-slug" });
    server.use(
      http.put("*/api/zero/org", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Slug is already taken",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 409 },
        );
      }),
    );

    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "taken-slug");

    await user.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });
  });

  it("should clear inline error on discard", async () => {
    const user = userEvent.setup();
    mockAPIs({ slug: "old-slug" });
    server.use(
      http.put("*/api/zero/org", () => {
        return HttpResponse.json(
          {
            error: {
              message: "Slug is already taken",
              code: "INTERNAL_SERVER_ERROR",
            },
          },
          { status: 409 },
        );
      }),
    );

    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "taken-slug");

    await user.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Discard"));

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
    const user = userEvent.setup();
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
    await fill(nameInput, "New Name");

    await user.click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({ name: "New Name" });
    });
  });
});

describe("org general tab - danger zone", () => {
  const CHOOSE_ORG_PATH = "/sign-in/tasks/choose-organization";

  afterEach(() => {
    // These tests intentionally navigate to choose-organization, so always
    // reset the location before the next test runs.
    if (window.location.pathname !== "/") {
      window.location.href = "http://localhost/";
    }
  });

  it("leaves workspace: clears active org then navigates to choose-organization", async () => {
    const user = userEvent.setup();
    const leaveCalled = vi.fn();
    mockAPIs({ role: "member", slug: "my-org" });
    server.use(
      http.post("*/api/zero/org/leave", () => {
        leaveCalled();
        return HttpResponse.json({ message: "ok" });
      }),
    );

    await openGeneralTab();

    const leaveTrigger = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Leave";
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    await user.click(leaveTrigger);

    const confirmBtn = await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const btn = buttons.find((el) => {
        return (
          el.textContent?.trim() === "Leave" && el.closest('[role="dialog"]')
        );
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(leaveCalled).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith({
        organization: null,
      });
    });

    await waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });

  it("deletes workspace: clears active org then navigates to choose-organization", async () => {
    const user = userEvent.setup();
    const deleteCalled = vi.fn();
    mockAPIs({ role: "admin", slug: "my-org" });
    server.use(
      http.post("*/api/zero/org/delete", () => {
        deleteCalled();
        return HttpResponse.json({ message: "ok" });
      }),
    );

    await openGeneralTab();

    const deleteTrigger = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Delete";
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    await user.click(deleteTrigger);

    const slugInput = await screen.findByPlaceholderText("my-org");
    await fill(slugInput, "my-org");

    const confirmBtn = await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const btn = buttons.find((el) => {
        return el.textContent?.trim() === "Delete workspace";
      });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
      return btn as HTMLElement;
    });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(deleteCalled).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith({
        organization: null,
      });
    });

    await waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });

  it("does not clear active org or navigate when leave API fails", async () => {
    const user = userEvent.setup();
    const leaveCalled = vi.fn();
    mockAPIs({ role: "member", slug: "my-org" });
    server.use(
      http.post("*/api/zero/org/leave", () => {
        leaveCalled();
        return HttpResponse.json(
          { error: { message: "boom", code: "INTERNAL_SERVER_ERROR" } },
          { status: 500 },
        );
      }),
    );

    await openGeneralTab();

    const leaveTrigger = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Leave";
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    await user.click(leaveTrigger);

    const confirmBtn = await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const btn = buttons.find((el) => {
        return (
          el.textContent?.trim() === "Leave" && el.closest('[role="dialog"]')
        );
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(leaveCalled).toHaveBeenCalledTimes(1);
    });

    // Session must not be touched on failure — otherwise a transient 5xx
    // could silently log the user out of their current workspace.
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(CHOOSE_ORG_PATH);
  });
});
