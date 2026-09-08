import { render, screen, waitFor } from "@testing-library/react";
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

test("Hover each action to discover its shortcut and dismiss it when leaving", async () => {
  const user = userEvent.setup();
  render(<ShortcutTooltipGroup items={items} />);
  const search = screen.getByLabelText("Search workspace");
  const pin = screen.getByLabelText("Pin chat");

  await user.hover(search);
  const searchTooltip = await screen.findByRole("tooltip", {
    name: "Search workspace Ctrl+Shift+F",
  });
  expect(searchTooltip).toBeVisible();

  await user.hover(pin);
  await expect(
    screen.findByRole("tooltip", { name: "Pin chat Ctrl+Shift+P" }),
  ).resolves.toBeVisible();
  await waitFor(() => {
    expect(searchTooltip).not.toBeVisible();
  });
  await user.unhover(pin);
  await waitFor(() => {
    expect(screen.queryAllByRole("tooltip")).toHaveLength(0);
  });
});
