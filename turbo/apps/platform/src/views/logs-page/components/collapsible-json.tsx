import { CopyButton } from "@vm0/ui";
import { IconChevronRight } from "@tabler/icons-react";

interface CollapsibleJsonProps {
  data: unknown;
  label?: string;
  defaultOpen?: boolean;
  maxPreviewLength?: number;
}

function generatePreview(data: unknown, maxLength: number): string {
  if (data === null || data === undefined) {
    return String(data);
  }

  if (typeof data === "string") {
    if (data.length > maxLength) {
      return `"${data.slice(0, maxLength)}..."`;
    }
    return `"${data}"`;
  }

  if (typeof data !== "object") {
    return String(data);
  }

  const json = JSON.stringify(data);
  if (json.length <= maxLength) {
    return json;
  }

  // For objects/arrays, show a truncated preview
  if (Array.isArray(data)) {
    return `[${data.length} items]`;
  }

  const keys = Object.keys(data);
  if (keys.length === 0) {
    return "{}";
  }

  // Show first key as preview
  const firstKey = keys[0];
  const firstValue = (data as Record<string, unknown>)[firstKey];
  const valuePreview =
    typeof firstValue === "string"
      ? `"${firstValue.slice(0, 20)}${firstValue.length > 20 ? "..." : ""}"`
      : typeof firstValue === "object"
        ? Array.isArray(firstValue)
          ? `[${firstValue.length}]`
          : "{...}"
        : String(firstValue);

  return `{ ${firstKey}: ${valuePreview}${keys.length > 1 ? ", ..." : ""} }`;
}

function JsonSyntaxHighlight({ json }: { json: string }) {
  // Simple syntax highlighting using regex
  const highlighted = json
    .replace(
      /"([^"]+)":/g,
      '<span class="text-purple-600 dark:text-purple-400">"$1"</span>:',
    )
    .replace(
      /: "([^"]*)"/g,
      ': <span class="text-green-600 dark:text-green-400">"$1"</span>',
    )
    .replace(
      /: (\d+\.?\d*)/g,
      ': <span class="text-blue-600 dark:text-blue-400">$1</span>',
    )
    .replace(
      /: (true|false)/g,
      ': <span class="text-amber-600 dark:text-amber-400">$1</span>',
    )
    .replace(
      /: (null)/g,
      ': <span class="text-gray-500 dark:text-gray-500">$1</span>',
    );

  return (
    <code
      className="text-sm"
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
}

export function CollapsibleJson({
  data,
  label,
  defaultOpen = false,
  maxPreviewLength = 60,
}: CollapsibleJsonProps) {
  const jsonString = JSON.stringify(data, null, 2);
  const preview = generatePreview(data, maxPreviewLength);
  const isSimple = jsonString.length < 100 && !jsonString.includes("\n");

  // For simple values, just show inline without collapse
  if (isSimple) {
    return (
      <div className="flex items-center gap-2 font-mono text-sm">
        {label && (
          <span className="text-muted-foreground shrink-0">{label}:</span>
        )}
        <JsonSyntaxHighlight json={jsonString} />
        <CopyButton text={jsonString} className="h-4 w-4 shrink-0 opacity-50" />
      </div>
    );
  }

  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 font-mono text-sm hover:bg-muted/50 rounded px-1 -mx-1">
        <IconChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {label && (
          <span className="text-muted-foreground shrink-0">{label}:</span>
        )}
        <span className="text-muted-foreground truncate group-open:hidden">
          {preview}
        </span>
        <span className="text-muted-foreground hidden group-open:inline">
          {Array.isArray(data) ? `[${(data as unknown[]).length} items]` : "{"}
        </span>
        <CopyButton
          text={jsonString}
          className="h-4 w-4 shrink-0 opacity-50 ml-auto"
        />
      </summary>
      <div className="mt-2 overflow-x-auto rounded bg-muted/30 p-3 font-mono text-sm">
        <pre className="whitespace-pre-wrap break-all">
          <JsonSyntaxHighlight json={jsonString} />
        </pre>
      </div>
    </details>
  );
}
