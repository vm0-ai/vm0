import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Toaster, toast } from "../sonner";

describe("Toaster", () => {
  afterEach(() => {
    toast.dismiss();
  });

  it("portals toast UI to body above app stacking contexts", async () => {
    const { container } = render(<Toaster />);

    toast.success("Saved");

    await screen.findByText("Saved");
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toBeInTheDocument();
    expect(container.contains(toaster)).toBeFalsy();
    expect(toaster).toHaveStyle({ zIndex: "2147483647" });
  });

  it("keeps mobile toast placement aligned with the viewport safe area", async () => {
    render(<Toaster />);

    toast.success("Saved");

    await screen.findByText("Saved");
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toBeInTheDocument();
    expect(toaster).toHaveStyle({ zIndex: "2147483647" });
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-top"),
    ).toBe("calc(var(--sat, 0px) + 12px)");
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-left"),
    ).toBe("0px");
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-right"),
    ).toBe("0px");
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-bottom"),
    ).toBe("calc(var(--sab, 0px) + 16px)");
  });
});
