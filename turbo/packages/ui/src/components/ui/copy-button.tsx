"use client";

import * as React from "react";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import { cn } from "../../lib/utils";

export interface CopyButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  text: string;
  resetDelay?: number;
}

const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ text, resetDelay = 2000, className, ...props }, ref) => {
    const [copied, setCopied] = React.useState(false);

    React.useEffect(() => {
      if (!copied) return;

      const timer = setTimeout(() => {
        setCopied(false);
      }, resetDelay);

      return () => clearTimeout(timer);
    }, [copied, resetDelay]);

    const handleCopy = () => {
      navigator.clipboard.writeText(text).then(
        () => setCopied(true),
        () => {
          // Clipboard API not available or failed
        },
      );
    };

    return (
      <button
        ref={ref}
        onClick={handleCopy}
        className={cn(
          "p-2 hover:bg-muted rounded-md transition-colors shrink-0",
          className,
        )}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        {...props}
      >
        {copied ? (
          <IconCheck className="h-4 w-4 text-green-500" />
        ) : (
          <IconCopy className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
    );
  },
);
CopyButton.displayName = "CopyButton";

export { CopyButton };
