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
            src="/Logo_VM0_white_bg.png"
            alt="VM0"
            width={24}
            height={24}
            className="dark:hidden"
          />
          <Image
            src="/Logo_VM0_black_bg.png"
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
