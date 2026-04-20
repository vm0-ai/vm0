"use client";

import { useState, useRef, useEffect } from "react";
import { useLocale } from "next-intl";
import { Link, usePathname } from "../../navigation";
import { locales, languageNames, type Locale } from "../../i18n";

interface LanguageSwitcherProps {
  openDirection?: "up" | "down";
}

export default function LanguageSwitcher({
  openDirection = "down",
}: LanguageSwitcherProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const pathname = usePathname();

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      return document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  return (
    <div className="language-switcher" ref={dropdownRef}>
      <button
        className="language-switcher-button"
        onClick={() => {
          return setIsOpen(!isOpen);
        }}
        aria-label="Switch language"
        title={languageNames[locale as Locale]}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M10 18C14.4183 18 18 14.4183 18 10C18 5.58172 14.4183 2 10 2C5.58172 2 2 5.58172 2 10C2 14.4183 5.58172 18 10 18Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2 10H18"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10 2C11.5 4 12 6.5 12 10C12 13.5 11.5 16 10 18C8.5 16 8 13.5 8 10C8 6.5 8.5 4 10 2Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div
        className={`language-switcher-dropdown ${openDirection === "up" ? "dropdown-up" : ""}`}
        hidden={!isOpen}
      >
        {locales.map((loc) => {
          return (
            <Link
              key={loc}
              href={pathname}
              locale={loc}
              onClick={() => {
                setIsOpen(false);
              }}
              className={`language-switcher-option ${
                locale === loc ? "active" : ""
              }`}
            >
              {languageNames[loc]}
              {locale === loc && (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M13.3333 4L6 11.3333L2.66666 8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
