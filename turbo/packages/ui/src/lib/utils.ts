import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Keep custom font-size tokens in the same group as text-sm. Without this
// mapping, tailwind-merge treats them as colors and removes text-foreground.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["action", "badge"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
