"use client";

import * as React from "react";
import {
  IconChevronDown,
  IconCheck,
  IconX,
  IconSearch,
} from "@tabler/icons-react";

import { cn } from "../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface ComboboxOption {
  value: string;
  label: string;
  icon?: string;
}

export interface MultiSelectComboboxProps {
  options: ComboboxOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  className?: string;
}

export function MultiSelectCombobox({
  options,
  selected,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  className,
}: MultiSelectComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  // Radix Dialog's react-remove-scroll adds a non-passive wheel listener on
  // document that calls preventDefault() for events outside the Dialog DOM.
  // Popover portal content is outside the Dialog DOM, so scroll gets blocked.
  // Native stopPropagation prevents the event from reaching that listener.
  const scrollContainerRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      const stop = (e: Event) => {
        return e.stopPropagation();
      };
      node.addEventListener("wheel", stop);
      node.addEventListener("touchmove", stop);
    },
    [],
  );

  const filtered = React.useMemo(() => {
    if (!search) return options;
    const lower = search.toLowerCase();
    return options.filter((o) => {
      return o.label.toLowerCase().includes(lower);
    });
  }, [options, search]);

  const selectedSet = React.useMemo(() => {
    return new Set(selected);
  }, [selected]);

  function toggle(value: string) {
    if (selectedSet.has(value)) {
      onChange(
        selected.filter((v) => {
          return v !== value;
        }),
      );
    } else {
      onChange([...selected, value]);
    }
  }

  function remove(value: string, e: React.SyntheticEvent) {
    e.stopPropagation();
    onChange(
      selected.filter((v) => {
        return v !== value;
      }),
    );
  }

  const selectedOptions = React.useMemo(() => {
    return selected
      .map((v) => {
        return options.find((o) => {
          return o.value === v;
        });
      })
      .filter((o): o is ComboboxOption => {
        return o !== undefined;
      });
  }, [selected, options]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="combobox"
          aria-expanded={open}
          tabIndex={0}
          className={cn(
            "flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-input px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10",
            className,
          )}
        >
          <div className="flex flex-1 flex-wrap items-center gap-1">
            {selectedOptions.length > 0 ? (
              selectedOptions.map((opt) => {
                return (
                  <span
                    key={opt.value}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-xs font-medium"
                  >
                    {opt.icon && (
                      <OptionIcon src={opt.icon} alt={opt.label} size={14} />
                    )}
                    {opt.label}
                    <span
                      role="button"
                      tabIndex={0}
                      className="ml-0.5 rounded-sm text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        return remove(opt.value, e);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          remove(opt.value, e);
                        }
                      }}
                      aria-label={`Remove ${opt.label}`}
                    >
                      <IconX size={12} />
                    </span>
                  </span>
                );
              })
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </div>
          <IconChevronDown
            size={16}
            className="shrink-0 text-muted-foreground"
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          searchInputRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          setSearch("");
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <IconSearch size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
        </div>
        <div ref={scrollContainerRef} className="max-h-60 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No results found
            </p>
          ) : (
            filtered.map((opt) => {
              const isSelected = selectedSet.has(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    return toggle(opt.value);
                  }}
                >
                  {opt.icon && (
                    <OptionIcon src={opt.icon} alt={opt.label} size={16} />
                  )}
                  <span className="flex-1 text-left">{opt.label}</span>
                  {isSelected && (
                    <IconCheck size={16} className="shrink-0 text-primary" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OptionIcon({
  src,
  alt,
  size,
}: {
  src: string;
  alt: string;
  size: number;
}) {
  const [error, setError] = React.useState(false);

  if (error) return null;

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      className="shrink-0 object-contain"
      onError={() => {
        return setError(true);
      }}
    />
  );
}
