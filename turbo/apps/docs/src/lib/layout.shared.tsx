import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

/**
 * Shared layout configurations
 *
 * you can customise layouts individually from:
 * Home Layout: app/(home)/layout.tsx
 * Docs Layout: app/docs/layout.tsx
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Image
            src="/vm0-logo.svg"
            alt="VM0"
            width={24}
            height={24}
            className="dark:hidden"
          />
          <Image
            src="/vm0-logo-dark.svg"
            alt="VM0"
            width={24}
            height={24}
            className="hidden dark:block"
          />
          VM0
        </>
      ),
    },
    // see https://fumadocs.dev/docs/ui/navigation/links
    links: [],
  };
}
