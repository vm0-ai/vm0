import { cn } from "@okouai/ui";

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

// Square thumbnails keep their corner radius at a constant quarter of the box,
// so a 24px logo and a 40px one read as the same shape at different scales.
// Same ratio the file-preview icon already uses (20px/5px, 40px/10px).
const THUMBNAIL_RADIUS = {
  sm: "rounded-[6px]",
  md: "rounded-[8px]",
  lg: "rounded-[10px]",
  xl: "rounded-[12px]",
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
 * A person: a circle by default, so it never reads as a workspace or an app
 * icon. The labeled navigation rail asks for `square` instead: there the
 * account mark sits directly under the workspace logo in a column of rounded
 * squares, and matching that shape is what keeps the column reading as a grid.
 * Falls back to the name's initial when the account has no picture.
 */
export function UserAvatar({
  imageUrl,
  name,
  initial,
  size = "md",
  shape = "circle",
}: {
  imageUrl: string | null | undefined;
  name: string;
  initial: string;
  size?: ThumbnailSize;
  shape?: "circle" | "square";
}) {
  const base = cn(
    THUMBNAIL_BASE,
    THUMBNAIL_SIZE[size],
    shape === "square" ? THUMBNAIL_RADIUS[size] : "rounded-full",
  );

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
  const base = cn(THUMBNAIL_BASE, THUMBNAIL_SIZE[size], THUMBNAIL_RADIUS[size]);

  if (imageUrl) {
    return (
      <img src={imageUrl} alt={name} className={cn(base, "object-cover")} />
    );
  }

  return (
    <div
      className={cn(
        base,
        "flex items-center justify-center bg-[hsl(var(--gray-200))] font-bold text-brand-text",
        THUMBNAIL_INITIAL_TEXT[size],
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
