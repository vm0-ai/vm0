import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "../copy-button";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CopyButton", () => {
  it("keeps confirmation state local to each button", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => {
      return Promise.resolve();
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(
      <>
        <CopyButton text="first" showTooltip={false} />
        <CopyButton text="second" showTooltip={false} />
      </>,
    );

    const [first, second] = screen.getAllByRole("button", {
      name: "Copy to clipboard",
    });
    if (!first || !second) {
      throw new Error("Expected two copy buttons");
    }
    expect(first).not.toHaveAttribute("data-base-ui-tooltip-trigger");
    expect(second).not.toHaveAttribute("data-base-ui-tooltip-trigger");

    fireEvent.click(first);
    await waitFor(() => {
      expect(first).toHaveAccessibleName("Copied");
      expect(second).toHaveAccessibleName("Copy to clipboard");
    });

    fireEvent.click(second);
    await waitFor(() => {
      expect(first).toHaveAccessibleName("Copied");
      expect(second).toHaveAccessibleName("Copied");
    });
    expect(writeText).toHaveBeenNthCalledWith(1, "first");
    expect(writeText).toHaveBeenNthCalledWith(2, "second");
  });

  it("clears its confirmation timer when unmounted", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => {
      return Promise.resolve();
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");

    const { unmount } = render(
      <CopyButton text="first" resetDelay={60_000} showTooltip={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAccessibleName("Copied");
    });

    const callsBeforeUnmount = clearTimeout.mock.calls.length;
    unmount();

    expect(clearTimeout).toHaveBeenCalledTimes(callsBeforeUnmount + 1);
  });
});
