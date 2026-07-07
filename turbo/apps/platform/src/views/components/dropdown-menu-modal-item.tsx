import type { ComponentPropsWithoutRef } from "react";
import { DropdownMenuItem } from "@vm0/ui";

import { runAfterDropdownMenuClose } from "./dropdown-menu-modal-action.ts";

type DropdownMenuModalItemProps = Omit<
  ComponentPropsWithoutRef<typeof DropdownMenuItem>,
  "onClick" | "onSelect"
> & {
  readonly onModalSelect: () => void;
};

export function DropdownMenuModalItem({
  onModalSelect,
  ...props
}: DropdownMenuModalItemProps) {
  return (
    <DropdownMenuItem
      {...props}
      onSelect={() => {
        runAfterDropdownMenuClose(onModalSelect);
      }}
    />
  );
}
