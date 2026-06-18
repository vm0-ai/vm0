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
});
