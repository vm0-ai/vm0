import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeUtilities = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["surface", "surface-compact"],
      shadow: ["surface"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return mergeUtilities(clsx(inputs));
}
