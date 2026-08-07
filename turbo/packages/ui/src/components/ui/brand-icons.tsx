import * as React from "react";
import type { LucideProps } from "lucide-react";

/**
 * Brand marks are not part of the Lucide set, so the five we use are vendored
 * here. The paths come from @tabler/icons (MIT) so the marks keep the exact
 * shape they had before the Lucide migration.
 *
 * These accept the same props as a Lucide icon and are drop-in compatible.
 */

type BrandIconProps = LucideProps;

function createBrandIcon(
  displayName: string,
  paths: readonly string[],
): React.ForwardRefExoticComponent<
  BrandIconProps & React.RefAttributes<SVGSVGElement>
> {
  const BrandIcon = React.forwardRef<SVGSVGElement, BrandIconProps>(
    (
      {
        size = 24,
        strokeWidth = 2,
        absoluteStrokeWidth,
        color = "currentColor",
        className,
        ...props
      },
      ref,
    ) => {
      return (
        <svg
          ref={ref}
          // The "lucide" class opts these into the global icon stroke rule in
          // styles/globals.css, so brand marks stay on the same weight as
          // every lucide-react icon.
          className={className ? `lucide ${className}` : "lucide"}
          xmlns="http://www.w3.org/2000/svg"
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth={
            absoluteStrokeWidth
              ? (Number(strokeWidth) * 24) / Number(size)
              : strokeWidth
          }
          strokeLinecap="round"
          strokeLinejoin="round"
          {...props}
        >
          {paths.map((d) => {
            return <path key={d} d={d} />;
          })}
        </svg>
      );
    },
  );

  BrandIcon.displayName = displayName;

  return BrandIcon;
}

export const GithubIcon = createBrandIcon("GithubIcon", [
  "M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5",
]);

export const GoogleDriveIcon = createBrandIcon("GoogleDriveIcon", [
  "M12 10l-6 10l-3 -5l6 -10l3 5",
  "M9 15h12l-3 5h-12",
  "M15 15l-6 -10h6l6 10l-6 0",
]);

export const NotionIcon = createBrandIcon("NotionIcon", [
  "M11 17.5v-6.5h.5l4 6h.5v-6.5",
  "M19.077 20.071l-11.53 .887a1 1 0 0 1 -.876 -.397l-2.471 -3.294a1 1 0 0 1 -.2 -.6v-10.741a1 1 0 0 1 .923 -.997l11.389 -.876a2 2 0 0 1 1.262 .33l1.535 1.023a2 2 0 0 1 .891 1.664v12.004a1 1 0 0 1 -.923 .997",
  "M4.5 5.5l2.5 2.5",
  "M20 7l-13 1v12.5",
]);

export const SlackIcon = createBrandIcon("SlackIcon", [
  "M12 12v-6a2 2 0 0 1 4 0v6m0 -2a2 2 0 1 1 2 2h-6",
  "M12 12h6a2 2 0 0 1 0 4h-6m2 0a2 2 0 1 1 -2 2v-6",
  "M12 12v6a2 2 0 0 1 -4 0v-6m0 2a2 2 0 1 1 -2 -2h6",
  "M12 12h-6a2 2 0 0 1 0 -4h6m-2 0a2 2 0 1 1 2 -2v6",
]);

export const TelegramIcon = createBrandIcon("TelegramIcon", [
  "M15 10l-4 4l6 6l4 -16l-18 7l4 2l2 6l3 -4",
]);
