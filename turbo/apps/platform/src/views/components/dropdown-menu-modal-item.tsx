import type { ComponentPropsWithoutRef } from "react";
import { DropdownMenuItem } from "@okouai/ui";

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
  return <DropdownMenuItem {...props} onSelect={onModalSelect} />;
}
