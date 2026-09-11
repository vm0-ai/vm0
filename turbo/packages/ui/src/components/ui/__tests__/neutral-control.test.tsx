import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog";
import { NeutralControl } from "../neutral-control";

describe("NeutralControl", () => {
  it("preserves a link's native element, destination, and keyboard focus", async () => {
    const user = userEvent.setup();
    const ref = { current: null as HTMLAnchorElement | null };
    const { container } = render(
      <NeutralControl ref={ref} render={<a href="/agents" />}>
        Back to agents
      </NeutralControl>,
    );

    const link = screen.getByRole("link", { name: "Back to agents" });
    expect(link).toHaveAttribute("href", "/agents");
    expect(container.firstElementChild).toBe(link);
    expect(screen.queryByRole("button")).toBeNull();
    expect(ref.current).toBe(link);
    await user.tab();
    expect(link).toHaveFocus();
  });

  it("opens a composed dialog and restores focus to its native trigger", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <NeutralControl type="button">Add automation</NeutralControl>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Choose automation</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Add automation" });
    expect(trigger).toHaveAttribute("type", "button");
    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Choose automation" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Choose automation" }),
      ).toBeNull();
      expect(trigger).toHaveFocus();
    });
  });
});
