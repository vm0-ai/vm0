import { cn } from "@vm0/ui";

type StatusDotVariant = "success" | "error" | "pending" | "neutral" | "todo";

interface StatusDotProps {
  variant: StatusDotVariant;
  className?: string;
}

function getVariantStyle(variant: StatusDotVariant): string {
  switch (variant) {
    case "success": {
      return "text-lime-500";
    }
    case "error": {
      return "text-red-500";
    }
    case "pending": {
      return "text-yellow-500";
    }
    case "neutral": {
      return "text-muted-foreground";
    }
    case "todo": {
      return "text-cyan-500";
    }
  }
}

export function StatusDot({ variant, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        "text-[10px] leading-none shrink-0 inline-block",
        getVariantStyle(variant),
        className,
      )}
      aria-hidden="true"
    >
      ●
    </span>
  );
}
