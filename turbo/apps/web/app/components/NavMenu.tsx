"use client";

import * as React from "react";
import Image from "next/image";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { IconArrowUpRight, IconChevronDown } from "@tabler/icons-react";
import { Link } from "../../navigation";

export interface NavMenuItem {
  label: string;
  description: string;
  href: string;
  icon: string;
  external?: boolean;
}

interface NavMenuProps {
  id: string;
  label: string;
  alignOffset?: number;
  items: NavMenuItem[];
  openId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
  onCancelClose: () => void;
  onScheduleClose: () => void;
}

export function NavMenu({
  id,
  label,
  items,
  alignOffset = 0,
  openId,
  onOpen,
  onClose,
  onCancelClose,
  onScheduleClose,
}: NavMenuProps) {
  const open = openId === id;

  const openSelf = React.useCallback(() => {
    onOpen(id);
  }, [id, onOpen]);

  const handleSelect = () => {
    onClose();
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpen(id);
          return;
        }
        onClose();
      }}
    >
      <PopoverPrimitive.Trigger
        type="button"
        className={`nav-trigger${open ? " nav-trigger-active" : ""}`}
        data-nav-menu-id={id}
        onPointerEnter={openSelf}
        onFocus={openSelf}
        onBlur={onScheduleClose}
      >
        {label}
        <IconChevronDown
          size={12}
          strokeWidth={1.8}
          className="nav-trigger-caret"
        />
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="center"
          alignOffset={alignOffset}
          sideOffset={8}
          className="nav-popover"
          data-nav-popover-id={id}
          onPointerEnter={onCancelClose}
          onPointerLeave={onScheduleClose}
          onOpenAutoFocus={(event: Event) => {
            event.preventDefault();
          }}
        >
          {items.map((item) => {
            return (
              <NavMenuRow key={item.href} item={item} onSelect={handleSelect} />
            );
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

interface NavMenuRowProps {
  item: NavMenuItem;
  onSelect: () => void;
}

function NavMenuRow({ item, onSelect }: NavMenuRowProps) {
  const body = (
    <>
      <Image
        src={item.icon}
        alt=""
        width={26}
        height={26}
        className="nav-popover-icon"
      />
      <span className="nav-popover-text">
        <span className="nav-popover-title-row">
          <span className="nav-popover-title">{item.label}</span>
          {item.external && (
            <IconArrowUpRight
              size={11}
              strokeWidth={1.8}
              className="nav-popover-ext"
            />
          )}
        </span>
        <span className="nav-popover-desc">{item.description}</span>
      </span>
    </>
  );

  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className="nav-popover-item"
        onClick={onSelect}
      >
        {body}
      </a>
    );
  }

  return (
    <Link href={item.href} className="nav-popover-item" onClick={onSelect}>
      {body}
    </Link>
  );
}
