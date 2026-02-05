import { cn } from "@vm0/ui";

type StatusDotVariant = "success" | "error" | "pending" | "neutral" | "todo";

interface StatusDotProps {
  variant: StatusDotVariant;
  className?: string;
}

function getVariantStyle(variant: StatusDotVariant): string {
  switch (variant) {
    case "success": {
      return "text-green-600";
    }
    case "error": {
      return "text-red-600";
    }
    case "pending": {
      return "text-yellow-500";
    }
    case "neutral": {
      return "text-muted-foreground";
    }
    case "todo": {
      return "text-sky-600";
    }
  }
}

export function StatusDot({ variant, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "text-[8px] leading-none shrink-0 inline-block",
        getVariantStyle(variant),
        className,
      )}
      aria-hidden="true"
    >
      ●
    </span>
  );
}
