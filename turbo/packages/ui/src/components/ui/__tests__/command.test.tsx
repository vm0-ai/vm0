import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import tailwindcss from "@tailwindcss/postcss";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postcss from "postcss";
import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from "../command";
import { DialogDescription, DialogTitle } from "../dialog";

function BasicCommand({
  onSelect,
}: {
  readonly onSelect: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <Command shouldFilter={false} loop value={query} onValueChange={setQuery}>
      <CommandInput aria-label="Search" />
      <CommandList>
        <CommandItem value="alpha" onSelect={onSelect}>
          Alpha
        </CommandItem>
        <CommandItem value="bravo" onSelect={onSelect}>
          Bravo
        </CommandItem>
        <CommandItem value="charlie" onSelect={onSelect}>
          Charlie
        </CommandItem>
      </CommandList>
    </Command>
  );
}

describe("Command", () => {
  const style = document.createElement("style");
  const packageRoot = existsSync(resolve(process.cwd(), "src/styles"))
    ? process.cwd()
    : resolve(process.cwd(), "packages/ui");
  const globalStylesPath = resolve(packageRoot, "src/styles/globals.css");

  beforeAll(async () => {
    const globalStyles = await readFile(globalStylesPath, "utf8");
    const compiledStyles = await postcss([
      tailwindcss({ base: packageRoot }),
    ]).process(globalStyles, { from: globalStylesPath });
    const radiusRules: string[] = [];
    compiledStyles.root.walkRules((rule) => {
      const declarations: string[] = [];
      rule.walkDecls((declaration) => {
        if (
          declaration.parent === rule &&
          (declaration.prop === "border-radius" ||
            declaration.prop.startsWith("--radius"))
        ) {
          declarations.push(declaration.toString());
        }
      });
      if (declarations.length > 0) {
        radiusRules.push(`${rule.selector} { ${declarations.join("; ")} }`);
      }
    });
    style.textContent = radiusRules.join("\n");
    document.head.append(style);
  });

  afterAll(() => {
    style.remove();
  });

  it("keeps the caret outside a rounded input clipping boundary", () => {
    render(<BasicCommand onSelect={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search" });
    const wrapper = input.closest<HTMLElement>(
      '[data-slot="command-input-wrapper"]',
    );

    if (wrapper === null) {
      throw new Error("Command input wrapper was not rendered");
    }
    expect(getComputedStyle(input).borderRadius).toBe("0px");
    expect(getComputedStyle(wrapper).borderRadius).not.toBe("0px");
  });

  it("selects with Enter and navigates up, down, and around the item loop", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<BasicCommand onSelect={onSelect} />);
    const input = screen.getByRole("combobox", { name: "Search" });
    const alpha = screen.getByRole("option", { name: "Alpha" });
    const bravo = screen.getByRole("option", { name: "Bravo" });
    const charlie = screen.getByRole("option", { name: "Charlie" });

    await user.click(input);
    await user.keyboard("{ArrowDown}");
    expect(alpha).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowDown}");
    expect(bravo).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowUp}");
    expect(alpha).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowUp}");
    expect(charlie).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(alpha).toHaveAttribute("data-highlighted");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("alpha");
  });

  it("uses dynamically rendered business-filtered results for keyboard selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    function DynamicCommand() {
      const [query, setQuery] = useState("");
      const items = ["Alpha", "Bravo", "Charlie"].filter((item) => {
        return item.toLowerCase().includes(query.toLowerCase());
      });
      return (
        <Command
          shouldFilter={false}
          loop
          value={query}
          onValueChange={setQuery}
        >
          <CommandInput aria-label="Dynamic search" />
          <CommandList>
            {items.map((item) => {
              const value = item.toLowerCase();
              return (
                <CommandItem key={value} value={value} onSelect={onSelect}>
                  {item}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      );
    }

    render(<DynamicCommand />);
    const input = screen.getByRole("combobox", { name: "Dynamic search" });
    await user.click(input);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
      "data-highlighted",
    );

    await user.type(input, "br");
    expect(screen.queryByRole("option", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("option", { name: "Bravo" })).toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("bravo");
    expect(input).toHaveValue("br");
  });

  it("lets Escape close its parent command dialog", async () => {
    const user = userEvent.setup();

    function DialogCommand() {
      const [open, setOpen] = useState(true);
      const [query, setQuery] = useState("");
      return (
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          commandProps={{
            shouldFilter: false,
            value: query,
            onValueChange: setQuery,
          }}
        >
          <DialogTitle>Choose a target</DialogTitle>
          <DialogDescription>Select one target</DialogDescription>
          <CommandInput aria-label="Dialog search" />
          <CommandList>
            <CommandItem value="alpha">Alpha</CommandItem>
          </CommandList>
        </CommandDialog>
      );
    }

    render(<DialogCommand />);
    const input = screen.getByRole("combobox", { name: "Dialog search" });
    await user.click(input);
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: "Choose a target" }),
    ).toBeNull();
  });

  it("keeps an embedded action from selecting its item", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onPin = vi.fn();
    render(
      <Command shouldFilter={false}>
        <CommandInput aria-label="Action search" />
        <CommandList>
          <CommandItem value="alpha" onSelect={onSelect}>
            Alpha
            <button
              type="button"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onPin();
              }}
            >
              Pin
            </button>
          </CommandItem>
        </CommandList>
      </Command>,
    );

    await user.click(screen.getByRole("button", { name: "Pin" }));

    expect(onPin).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
