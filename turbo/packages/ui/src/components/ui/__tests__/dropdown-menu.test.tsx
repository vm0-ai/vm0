import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../dropdown-menu";

function TestMenu({ keepOpen = false }: { keepOpen?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button">Actions</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onSelect={(event) => {
            if (keepOpen) {
              event.preventDefault();
            }
          }}
        >
          Rename
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("DropdownMenu", () => {
  it("keeps legacy onSelect preventDefault behavior", async () => {
    render(<TestMenu keepOpen />);

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("does not restore trigger focus after a pointer dismissal", async () => {
    render(<TestMenu />);

    const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(trigger);
    await screen.findByRole("menu");
    const focus = vi.spyOn(trigger, "focus");

    fireEvent.pointerDown(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(focus).not.toHaveBeenCalled();
  });

  it("restores trigger focus after Escape", async () => {
    render(<TestMenu />);

    const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it("opens a submenu when its trigger is clicked", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Archive</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const submenuTrigger = await screen.findByRole("menuitem", {
      name: "More",
    });
    fireEvent.pointerDown(submenuTrigger, { button: 0 });
    fireEvent.click(submenuTrigger);

    expect(
      await screen.findByRole("menuitem", { name: "Archive" }),
    ).toBeVisible();
  });
});
