import { cva } from "class-variance-authority";

/**
 * Inline badges and tags: a hairline stroke over the neutral fill, applied to
 * the host element so its layout, display, radius, and text semantics stay
 * where the consumer declares them.
 */
const badgeVariants = cva(
  "border-(length:--border-width-surface) border-solid border-surface-border bg-gray-0",
);

export { badgeVariants };
