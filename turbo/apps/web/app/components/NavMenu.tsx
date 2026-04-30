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
  label: string;
  alignOffset?: number;
  items: NavMenuItem[];
}

const CLOSE_DELAY_MS = 120;

export function NavMenu({ label, items, alignOffset = 0 }: NavMenuProps) {
  const [open, setOpen] = React.useState(false);
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
      setOpen(false);
    }, CLOSE_DELAY_MS);
  }, [cancelClose]);

  React.useEffect(() => {
    return () => {
      cancelClose();
    };
  }, [cancelClose]);

  const handleSelect = () => {
    cancelClose();
    setOpen(false);
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        className={`nav-trigger${open ? " nav-trigger-active" : ""}`}
        onPointerEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onPointerLeave={scheduleClose}
        onFocus={() => {
          cancelClose();
          setOpen(true);
        }}
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
