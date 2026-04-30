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
  onOpenChange: (id: string | null) => void;
}

const CLOSE_DELAY_MS = 250;

export function NavMenu({
  id,
  label,
  items,
  alignOffset = 0,
  openId,
  onOpenChange,
}: NavMenuProps) {
  const open = openId === id;
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = React.useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = React.useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      onOpenChange(null);
    }, CLOSE_DELAY_MS);
  }, [cancelClose, onOpenChange]);

  const openSelf = React.useCallback(() => {
    cancelClose();
    onOpenChange(id);
  }, [cancelClose, id, onOpenChange]);

  React.useEffect(() => {
    return () => {
      cancelClose();
    };
  }, [cancelClose]);

  const handleSelect = () => {
    cancelClose();
    onOpenChange(null);
  };

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next ? id : null);
      }}
    >
      <PopoverPrimitive.Trigger
        type="button"
        className={`nav-trigger${open ? " nav-trigger-active" : ""}`}
        onPointerEnter={openSelf}
        onPointerLeave={scheduleClose}
        onFocus={openSelf}
        onBlur={scheduleClose}
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
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
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
