import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../dialog";

describe("Dialog", () => {
  it("preserves the preview and nested focus ownership across fullscreen changes", async () => {
    const user = userEvent.setup();
    function Preview() {
      const [fullscreen, setFullscreen] = useState(false);
      return (
        <Dialog>
          <DialogTrigger>Open preview</DialogTrigger>
          <DialogContent
            maxWidth={1440}
            height={1000}
            mode={fullscreen ? "fullscreen" : "windowed"}
          >
            <DialogTitle>Image preview</DialogTitle>
            <button
              onClick={() => {
                setFullscreen(!fullscreen);
              }}
            >
              {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            </button>
            <DialogBody>
              <input aria-label="Annotation" />
              <Dialog>
                <DialogTrigger>Open details</DialogTrigger>
                <DialogContent>
                  <DialogTitle>Image details</DialogTitle>
                  <input aria-label="Description" />
                </DialogContent>
              </Dialog>
            </DialogBody>
          </DialogContent>
        </Dialog>
      );
    }
    render(<Preview />);
    const trigger = screen.getByRole("button", { name: "Open preview" });
    await user.click(trigger);
    const preview = screen.getByRole("dialog", { name: "Image preview" });
    await user.type(
      screen.getByRole("textbox", { name: "Annotation" }),
      "Keep this draft",
    );
    await user.click(screen.getByRole("button", { name: "Enter fullscreen" }));
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBe(preview);
    expect(screen.getByRole("textbox", { name: "Annotation" })).toHaveValue(
      "Keep this draft",
    );

    const detailsTrigger = screen.getByRole("button", { name: "Open details" });
    await user.click(detailsTrigger);
    expect(screen.getByRole("dialog", { name: "Image details" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(detailsTrigger).toHaveFocus();
    });
    expect(screen.queryByRole("dialog", { name: "Image details" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Exit fullscreen" }));
    expect(screen.getByRole("textbox", { name: "Annotation" })).toHaveValue(
      "Keep this draft",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });

  it("applies Base UI animations that run on initial mount", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Default dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "data-open:animate-[okou-dialog-backdrop-in_150ms_ease-out]",
      "data-closed:animate-[okou-dialog-backdrop-out_150ms_ease-out]",
      "motion-reduce:animate-none",
    );
    expect(screen.getByRole("dialog", { name: "Default dialog" })).toHaveClass(
      "data-open:animate-[okou-dialog-popup-in_150ms_ease-out]",
      "data-closed:animate-[okou-dialog-popup-out_150ms_ease-out]",
      "motion-reduce:animate-none",
    );
    expect(
      screen.getByRole("dialog", { name: "Default dialog" }),
    ).toHaveAttribute("data-open");
  });

  it("renders an overlay for nested dialogs", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Parent dialog</DialogTitle>
          <Dialog open>
            <DialogContent>
              <DialogTitle>Nested dialog</DialogTitle>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>,
    );

    expect(
      document.querySelectorAll('[data-slot="dialog-overlay"]'),
    ).toHaveLength(2);
  });

  it("can leave close controls to a custom dialog header", () => {
    render(
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Custom header dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
