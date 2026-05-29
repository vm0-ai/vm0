"use client";

import { useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";

export function CopyablePrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(prompt)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 1500);
      })
      .catch((error: unknown) => {
        // Log error when clipboard API is unavailable (e.g., insecure context)
        console.warn("Failed to copy to clipboard:", error);
      });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label="Copy prompt"
      className="group/copy relative block w-full cursor-pointer text-left"
    >
      <pre className="max-h-[120px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[hsl(var(--gray-1))] px-3 py-2.5 pr-16 font-mono text-[12px] leading-[1.5] text-[hsl(var(--muted-foreground))]">
        {prompt}
      </pre>
      <span
        className={`absolute right-2 top-2 inline-flex items-center gap-1 rounded-[6px] bg-[hsl(var(--foreground))] px-2 py-1 text-[11px] font-medium text-white transition-opacity duration-150 group-hover/copy:opacity-100 ${
          copied ? "opacity-100" : "opacity-0"
        }`}
      >
        {copied ? (
          <>
            <IconCheck size={12} stroke={2.5} />
            Copied
          </>
        ) : (
          <>
            <IconCopy size={12} stroke={2} />
            Copy
          </>
        )}
      </span>
    </button>
  );
}
