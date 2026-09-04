import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SegmentControl, SegmentControlItem } from "../segment-control";

function renderAspectRatioControl(
  props: Partial<React.ComponentProps<typeof SegmentControl<string>>> = {},
) {
  return render(
    <SegmentControl
      aria-label="Aspect ratio"
      defaultValue="portrait"
      {...props}
    >
      <SegmentControlItem value="portrait">9:16</SegmentControlItem>
      <SegmentControlItem value="landscape">16:9</SegmentControlItem>
    </SegmentControl>,
  );
}

describe("SegmentControl", () => {
  it("uses the dedicated track token for the default variant", () => {
    renderAspectRatioControl();

    expect(
      screen.getByRole("radiogroup", { name: "Aspect ratio" }),
    ).toHaveClass("bg-segment-track");
  });

  it("selects a segment on click", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    renderAspectRatioControl({ onValueChange });

    await user.click(screen.getByRole("radio", { name: "16:9" }));

    expect(onValueChange).toHaveBeenCalledWith("landscape", expect.anything());
    expect(screen.getByRole("radio", { name: "16:9" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "9:16" })).not.toBeChecked();
  });

  it("keeps exactly one segment selected when the selection is clicked again", async () => {
    const user = userEvent.setup();
    renderAspectRatioControl();

    await user.click(screen.getByRole("radio", { name: "9:16" }));

    expect(screen.getByRole("radio", { name: "9:16" })).toBeChecked();
  });

  it("moves the selection with the arrow keys", async () => {
    const user = userEvent.setup();
    renderAspectRatioControl();

    await user.tab();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("radio", { name: "16:9" })).toBeChecked();
  });

  it("skips a disabled segment", async () => {
    const user = userEvent.setup();
    render(
      <SegmentControl aria-label="Visibility" defaultValue="public">
        <SegmentControlItem value="public">Public</SegmentControlItem>
        <SegmentControlItem value="private" disabled>
          Private
        </SegmentControlItem>
      </SegmentControl>,
    );

    await user.click(screen.getByRole("radio", { name: "Private" }));

    expect(screen.getByRole("radio", { name: "Public" })).toBeChecked();
  });
});
