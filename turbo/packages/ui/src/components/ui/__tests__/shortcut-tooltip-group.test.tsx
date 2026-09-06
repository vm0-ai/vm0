import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { Button } from "../button";
import { ShortcutTooltipGroup } from "../shortcut-tooltip-group";

const items = [
  {
    shortcut: "mod+shift+f",
    trigger: <Button aria-label="Search workspace">Search</Button>,
  },
  {
    shortcut: "mod+shift+o",
    trigger: <Button aria-label="New chat">New</Button>,
  },
  {
    shortcut: "mod+b",
    trigger: <Button aria-label="Hide chat list">Hide</Button>,
  },
  {
    shortcut: "mod+shift+p",
    trigger: <Button aria-label="Pin chat">Pin</Button>,
  },
];

test("A fourth button adds a row to the same ordered hint panel", async () => {
  render(<ShortcutTooltipGroup items={items} hintVisible />);

  await expect(screen.findByText("Ctrl+Shift+P")).resolves.toBeVisible();
  const panels = screen.getAllByRole("tooltip", { hidden: true });
  expect(panels).toHaveLength(1);
  const panel = panels[0]!;
  expect(
    within(panel)
      .getAllByRole("term", { hidden: true })
      .map((row) => {
        return row.textContent;
      }),
  ).toEqual(["Search workspace", "New chat", "Hide chat list", "Pin chat"]);
  expect(
    [...panel.querySelectorAll("kbd")].map((key) => {
      return key.textContent;
    }),
  ).toEqual(["Ctrl+Shift+F", "Ctrl+Shift+O", "Ctrl+B", "Ctrl+Shift+P"]);
});

test("Group hints replace an open hover label and restore the currently hovered button on release", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <ShortcutTooltipGroup items={items} hintVisible={false} />,
  );
  const search = screen.getByLabelText("Search workspace");
  const pin = screen.getByLabelText("Pin chat");

  await user.hover(search);
  const hoverLabel = await screen.findByRole("tooltip", {
    name: "Search workspace",
  });
  expect(hoverLabel).toBeVisible();

  rerender(<ShortcutTooltipGroup items={items} hintVisible />);
  await expect(screen.findByText("Ctrl+Shift+P")).resolves.toBeVisible();
  await waitFor(() => {
    expect(hoverLabel).not.toBeVisible();
  });
  await user.hover(pin);
  expect(screen.queryByRole("tooltip", { name: "Pin chat" })).toBeNull();

  rerender(<ShortcutTooltipGroup items={items} hintVisible={false} />);
  await expect(
    screen.findByRole("tooltip", { name: "Pin chat" }),
  ).resolves.toBeVisible();
  await user.unhover(pin);
  await waitFor(() => {
    expect(screen.queryByRole("tooltip", { name: "Pin chat" })).toBeNull();
  });
  expect(
    screen.queryByRole("tooltip", { name: "Search workspace" }),
  ).toBeNull();
});

test("Leaving the group while hints are visible does not resurrect a stale hover label", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <ShortcutTooltipGroup items={items} hintVisible={false} />,
  );
  const search = screen.getByLabelText("Search workspace");
  await user.hover(search);
  await screen.findByRole("tooltip", { name: "Search workspace" });
  rerender(<ShortcutTooltipGroup items={items} hintVisible />);
  await screen.findByText("Ctrl+Shift+P");
  await user.unhover(search);
  rerender(<ShortcutTooltipGroup items={items} hintVisible={false} />);

  await waitFor(() => {
    expect(screen.queryAllByRole("tooltip", { hidden: true })).toHaveLength(0);
  });
});
