import { cn } from "@vm0/ui";

/**
 * Shared thumbnail scale for the two identity marks in the app chrome: the
 * person behind the session (`UserAvatar`) and the workspace they are in
 * (`WorkspaceLogo`). Both draw from the same size and stroke vocabulary so a
 * user avatar and a workspace logo sitting in the same column line up.
 */
const THUMBNAIL_SIZE = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
  lg: "h-10 w-10",
  xl: "h-12 w-12",
} as const;

const THUMBNAIL_INITIAL_TEXT = {
  sm: "text-[11px]",
  md: "text-xs",
  lg: "text-sm",
  xl: "text-base",
} as const;

type ThumbnailSize = keyof typeof THUMBNAIL_SIZE;

// `zero-thumb-border` is the 0.5px hairline every thumbnail carries so its
// bounds stay readable against the sidebar, cards, and menus alike — including
// avatars whose artwork fades out at the edge.
const THUMBNAIL_BASE = "shrink-0 zero-thumb-border";

/**
 * A person: always a circle, so it never reads as a workspace or an app icon.
 * Falls back to the name's initial when the account has no picture.
 */
export function UserAvatar({
  imageUrl,
  name,
  initial,
  size = "md",
}: {
  imageUrl: string | null | undefined;
  name: string;
  initial: string;
  size?: ThumbnailSize;
}) {
  const base = cn(THUMBNAIL_BASE, THUMBNAIL_SIZE[size], "rounded-full");

  if (imageUrl) {
    return (
      <img src={imageUrl} alt={name} className={cn(base, "object-cover")} />
    );
  }

  return (
    <div
      className={cn(
        base,
        "flex items-center justify-center bg-muted font-medium text-muted-foreground",
        THUMBNAIL_INITIAL_TEXT[size],
      )}
    >
      {initial}
    </div>
  );
}

/**
 * A workspace: a rounded square, the shape brands are drawn for. Kept visually
 * distinct from `UserAvatar` on purpose — the shape is what tells the two
 * sidebar rows apart once they share a size.
 */
export function WorkspaceLogo({
  name,
  imageUrl,
  size = "sm",
}: {
  name: string;
  imageUrl?: string | null;
  size?: ThumbnailSize;
}) {
  const radius = size === "sm" || size === "md" ? "rounded-md" : "rounded-xl";
  const base = cn(THUMBNAIL_BASE, THUMBNAIL_SIZE[size], radius);

  if (imageUrl) {
    return (
      <img src={imageUrl} alt={name} className={cn(base, "object-cover")} />
    );
  }

  return (
    <div
      className={cn(
        base,
        "flex items-center justify-center bg-[hsl(var(--gray-200))] font-bold text-[hsl(var(--primary-700))]",
        THUMBNAIL_INITIAL_TEXT[size],
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
