import { useGet, useLoadable, useSet } from "ccstate-react";
import { IconCode, IconLoader2 } from "@tabler/icons-react";
import type {
  MemoryInjectionItem,
  MemoryInjectionPreviewResponse,
  MemorySearchResult,
} from "@vm0/api-contracts/contracts/zero-memory";
import { Button, cn } from "@vm0/ui";

import {
  memoryInjectionPreview$,
  memoryInjectionPrompt$,
  setMemoryInjectionPrompt$,
  submitMemoryInjectionPreview$,
  submittedMemoryInjectionPrompt$,
} from "../../signals/memory-page/memory-signals.ts";

function formatKind(kind: MemoryInjectionItem["kind"]): string {
  switch (kind) {
    case "key_fact": {
      return "Key fact";
    }
    case "preference": {
      return "Preference";
    }
    case "open_loop": {
      return "Open loop";
    }
    case "role": {
      return "Role";
    }
    case "project": {
      return "Project";
    }
    case "communication_style": {
      return "Communication style";
    }
    case "recent_context": {
      return "Recent context";
    }
  }
}

function MemoryInjectionEmpty({
  submittedPrompt,
}: {
  readonly submittedPrompt: string;
}) {
  const hasPrompt = submittedPrompt.trim().length > 0;
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          {hasPrompt
            ? "No memory context generated"
            : "No injection preview yet"}
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {hasPrompt
            ? "The prompt did not match injectable memories."
            : "Enter a user prompt to preview the memory block Zero would append."}
        </p>
      </div>
    </div>
  );
}

function MemoryInjectionSkeleton() {
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Building injection preview
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Loading prompt-relevant memory.
        </p>
      </div>
    </div>
  );
}

function MemoryInjectionError() {
  return (
    <div className="flex min-h-[320px] items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Injection preview unavailable
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Try again once relationship memory runtime injection is enabled.
        </p>
      </div>
    </div>
  );
}

function MemoryGroup({
  items,
  title,
}: {
  readonly items: readonly MemoryInjectionItem[];
  readonly title: string;
}) {
  return (
    <section className="rounded-md border border-border/70 bg-background">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-col divide-y divide-border/70">
          {items.map((item) => {
            const source = item.sources[0] ?? null;
            return (
              <article key={item.id} className="px-3 py-2">
                <p className="text-sm leading-5 text-foreground">{item.text}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {formatKind(item.kind)} - {item.entity.displayName} -
                  confidence {item.confidence}
                </p>
                <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">
                  id={item.id}
                  {source ? ` - ${source.provider}:${source.externalId}` : ""}
                </p>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          No memories
        </div>
      )}
    </section>
  );
}

function DocumentEvidenceGroup({
  items,
}: {
  readonly items: readonly Extract<
    MemorySearchResult,
    { readonly kind: "document_chunk" }
  >[];
}) {
  return (
    <section className="rounded-md border border-border/70 bg-background">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <h3 className="text-xs font-medium text-muted-foreground">
          Source evidence
        </h3>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-col divide-y divide-border/70">
          {items.map((item) => {
            return (
              <article key={item.chunkId} className="px-3 py-2">
                <p className="text-sm font-medium leading-5 text-foreground">
                  {item.title ?? item.externalId}
                </p>
                <p className="line-clamp-3 text-xs leading-5 text-muted-foreground">
                  {item.text}
                </p>
                <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">
                  {item.provider}:{item.externalId}
                  {item.citation.locator ? ` - ${item.citation.locator}` : ""}
                </p>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          No source evidence
        </div>
      )}
    </section>
  );
}

function MemoryInjectionResults({
  data,
}: {
  readonly data: MemoryInjectionPreviewResponse | null;
}) {
  if (!data || data.appendSystemPrompt.length === 0) {
    return <MemoryInjectionEmpty submittedPrompt="submitted" />;
  }

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_280px]">
      <section className="min-w-0 rounded-md border border-border/70 bg-background">
        <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            Append system prompt
          </h3>
          <span className="text-xs text-muted-foreground">
            {data.stats.tokenCount} tokens
          </span>
        </div>
        <pre className="max-h-[520px] overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5 text-foreground">
          {data.appendSystemPrompt}
        </pre>
      </section>
      <aside className="flex min-w-0 flex-col gap-3">
        <div className="rounded-md border border-border/70 bg-background px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">Stats</p>
          <p className="mt-1 text-sm text-foreground">
            {data.stats.injectedCount} injected, {data.stats.omittedCount}{" "}
            omitted
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {data.stats.profileTokenCount} profile,{" "}
            {data.stats.memoryTokenCount} memory,{" "}
            {data.stats.documentTokenCount} evidence tokens
          </p>
        </div>
        <MemoryGroup title="Relevant memories" items={data.queryMemories} />
        <DocumentEvidenceGroup items={data.documentEvidence} />
      </aside>
    </div>
  );
}

export function MemoryInjection() {
  const prompt = useGet(memoryInjectionPrompt$);
  const submittedPrompt = useGet(submittedMemoryInjectionPrompt$);
  const setPrompt = useSet(setMemoryInjectionPrompt$);
  const submit = useSet(submitMemoryInjectionPreview$);
  const previewLoadable = useLoadable(memoryInjectionPreview$);
  const loading =
    previewLoadable.state === "loading" && submittedPrompt.trim().length > 0;

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <form
        className="border-b border-border/70 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col gap-3">
          <textarea
            value={prompt}
            placeholder="User prompt to preview memory injection"
            className={cn(
              "min-h-[92px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-5 text-foreground",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            onChange={(event) => {
              setPrompt(event.target.value);
            }}
          />
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              className="h-9 gap-1.5 px-3 text-sm"
              disabled={loading || prompt.trim().length === 0}
            >
              {loading ? (
                <IconLoader2 className="h-4 w-4 animate-spin" />
              ) : (
                <IconCode className="h-4 w-4" />
              )}
              <span>{loading ? "Previewing" : "Preview injection"}</span>
            </Button>
          </div>
        </div>
      </form>

      {previewLoadable.state === "loading" ? (
        loading ? (
          <MemoryInjectionSkeleton />
        ) : (
          <MemoryInjectionEmpty submittedPrompt={submittedPrompt} />
        )
      ) : null}
      {previewLoadable.state === "hasError" ? <MemoryInjectionError /> : null}
      {previewLoadable.state === "hasData" ? (
        <MemoryInjectionResults data={previewLoadable.data} />
      ) : null}
    </section>
  );
}
