import { cn } from "@vm0/ui";

/**
 * Deterministic color for a custom connector based on its UUID.
 * Rename-stable: the id is hashed (not the display name) so the color
 * persists across PATCH /displayName.
 */
function hashToHue(id: string): number {
  // Classic FNV-1a 32-bit, then mod 360 for an HSL hue.
  let hash = 0x81_1c_9d_c5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return Math.abs(hash) % 360;
}

function initial(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "?";
  }
  // Prefer the first alphabetic char, else fall back to the first grapheme
  // (emoji / digit / non-latin) so we never render a blank avatar.
  const firstLetter = trimmed.match(/\p{L}/u)?.[0];
  return (firstLetter ?? trimmed[0] ?? "?").toUpperCase();
}

export function CustomConnectorIcon({
  id,
  displayName,
  size = 28,
}: {
  id: string;
  displayName: string;
  size?: number;
}) {
  const hue = hashToHue(id);
  // Fixed S/L tuned for decent contrast in both themes. Foreground picked
  // to flip with the lightness so the letter is always legible.
  const bg = `hsl(${hue} 55% 45%)`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white",
      )}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize: Math.max(10, Math.round(size * 0.45)),
      }}
      aria-label={displayName}
    >
      {initial(displayName)}
    </span>
  );
}
