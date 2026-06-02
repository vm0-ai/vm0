import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setMockMemory } from "../../../mocks/handlers/api-memory.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";

const context = testContext();

function setupMemoryPage(): void {
  setMockMemory({
    exists: true,
    name: "memory",
    size: 60,
    fileCount: 2,
    updatedAt: "2024-01-01T00:00:00Z",
    files: [
      { path: "MEMORY.md", size: 30 },
      { path: "scratch.txt", size: 30 },
    ],
    fileContents: [
      { path: "MEMORY.md", content: "# Memory Index\n\nThings I know." },
      { path: "scratch.txt", content: "Plain scratch note." },
    ],
  });

  detachedSetupPage({
    context,
    path: "/memory",
    featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
  });
}

describe("memory page", () => {
  it("redirects to home when MemoryViewer is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: false },
    });

    await waitFor(() => {
      expect(context.store.get(pathname$)).not.toBe("/memory");
    });
  });

  it("shows an empty state when there is no memory", async () => {
    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No memory yet")).toBeInTheDocument();
    });
  });

  it("lists memory files and shows selected file content read-only", async () => {
    setupMemoryPage();

    // Defaults to MEMORY.md (rendered as markdown).
    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "Things I know.",
      );
    });

    expect(screen.getAllByText("MEMORY.md").length).toBeGreaterThan(0);
    expect(screen.getAllByText("scratch.txt").length).toBeGreaterThan(0);

    const scratchButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("scratch.txt");
    });
    expect(scratchButton).toBeDefined();
    click(scratchButton!);

    await waitFor(() => {
      expect(screen.getByLabelText("Memory content")).toHaveTextContent(
        "Plain scratch note.",
      );
    });

    // Read-only: no edit/save affordances.
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.textContent === "Save";
      }),
    ).toBeFalsy();
  });
});
