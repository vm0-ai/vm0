import { useLastLoadable, useGet, useLastResolved } from "ccstate-react";
import { IconChartLine } from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Skeleton,
} from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/core";
import { Link } from "../router/link.tsx";
import { currentRunId$ } from "../../signals/activity-page/activity-signals.ts";
import { zeroActivityContext$ } from "../../signals/activity-page/activity-context-signals.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
  );
}

function CodeBlock({ value }: { value: string }) {
  return (
    <pre className="rounded-md border bg-muted/50 p-3 text-xs leading-relaxed overflow-auto max-h-80 whitespace-pre-wrap break-words">
      {value}
    </pre>
  );
}

function KeyValueTable({
  data,
  keyLabel = "Name",
  valueLabel = "Value",
}: {
  data: Record<string, string>;
  keyLabel?: string;
  valueLabel?: string;
}) {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">None</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-1/3">{keyLabel}</TableHead>
          <TableHead>{valueLabel}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([key, value]) => {
          return (
            <TableRow key={key}>
              <TableCell className="font-mono text-xs">{key}</TableCell>
              <TableCell className="font-mono text-xs break-all">
                {value}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function StorageTable({
  items,
  columns,
}: {
  items: {
    mountPath: string;
    vasStorageName: string;
    vasVersionId: string;
    name?: string;
  }[];
  columns: string[];
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">None</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => {
            return <TableHead key={col}>{col}</TableHead>;
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          return (
            <TableRow key={`${item.vasStorageName}-${item.vasVersionId}`}>
              {item.name !== undefined && (
                <TableCell className="font-mono text-xs">{item.name}</TableCell>
              )}
              <TableCell className="font-mono text-xs">
                {item.mountPath}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {item.vasStorageName}
              </TableCell>
              <TableCell className="font-mono text-xs truncate max-w-[200px]">
                {item.vasVersionId}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ZeroActivityContextPage() {
  const currentRunId = useGet(currentRunId$);
  const contextLoadable = useLastLoadable(zeroActivityContext$);

  if (
    contextLoadable.state === "loading" ||
    contextLoadable.state === "hasError"
  ) {
    return <ContextSkeleton runId={currentRunId} />;
  }

  const context = contextLoadable.data;
  if (!context) {
    return <ContextNotAvailable runId={currentRunId} />;
  }

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0 overflow-auto">
        <Breadcrumb runId={currentRunId} />
        <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6 pt-4 pb-8 flex flex-col gap-6">
          {/* Prompt */}
          <section>
            <SectionHeader title="Prompt" />
            <CodeBlock value={context.prompt} />
          </section>

          {/* System Prompt */}
          {context.appendSystemPrompt && (
            <section>
              <SectionHeader title="System Prompt" />
              <CodeBlock value={context.appendSystemPrompt} />
            </section>
          )}

          {/* Secrets */}
          <section>
            <SectionHeader title="Secrets" />
            {context.secretNames.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {context.secretNames.map((name) => {
                  return (
                    <span
                      key={name}
                      className="inline-flex items-center rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-mono"
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </section>

          {/* Variables */}
          <section>
            <SectionHeader title="Variables" />
            {context.vars ? (
              <KeyValueTable data={context.vars} />
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </section>

          {/* Environment Mapping */}
          <section>
            <SectionHeader title="Environment Mapping" />
            <KeyValueTable data={context.environment} />
          </section>

          {/* Firewalls */}
          <section>
            <SectionHeader title="Firewalls" />
            {context.firewalls.length > 0 ? (
              <CodeBlock value={JSON.stringify(context.firewalls, null, 2)} />
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </section>

          {/* Volumes */}
          <section>
            <SectionHeader title="Volumes" />
            <StorageTable
              items={context.volumes}
              columns={["Name", "Mount Path", "Storage Name", "Version"]}
            />
          </section>

          {/* Artifact */}
          <section>
            <SectionHeader title="Artifact" />
            {context.artifact ? (
              <StorageTable
                items={[context.artifact]}
                columns={["Mount Path", "Storage Name", "Version"]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </section>

          {/* Memory */}
          <section>
            <SectionHeader title="Memory" />
            {context.memory ? (
              <StorageTable
                items={[context.memory]}
                columns={["Mount Path", "Storage Name", "Version"]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">None</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function Breadcrumb({ runId }: { runId: string | null }) {
  const features = useLastResolved(featureSwitch$);
  return (
    <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
      {features?.[FeatureSwitchKey.ActivityLogList] && (
        <>
          <Link
            pathname="/activity"
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
          >
            <IconChartLine size={14} stroke={1.5} className="shrink-0" />
            Activity
          </Link>
          <span className="text-muted-foreground/40 select-none">/</span>
        </>
      )}
      {runId && (
        <>
          <Link
            pathname="/activity/:runId"
            options={{ pathParams: { runId } }}
            className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
          >
            Run
          </Link>
          <span className="text-muted-foreground/40 select-none">/</span>
        </>
      )}
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
        Context
      </span>
    </nav>
  );
}

function ContextNotAvailable({ runId }: { runId: string | null }) {
  return (
    <div className="h-full flex flex-col min-h-0">
      <Breadcrumb runId={runId} />
      <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-20">
        <h2 className="text-lg font-semibold text-foreground">
          Context not available
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          Execution context is not available for this run. It may be an older
          run created before context snapshots were enabled.
        </p>
        {runId && (
          <Link
            pathname="/activity/:runId"
            options={{ pathParams: { runId } }}
            className="zero-btn-morandi mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
          >
            Back to run
          </Link>
        )}
      </div>
    </div>
  );
}

function ContextSkeleton({ runId }: { runId: string | null }) {
  return (
    <div className="h-full flex flex-col min-h-0">
      <Breadcrumb runId={runId} />
      <div className="mx-auto w-full max-w-[900px] px-4 sm:px-6 pt-4 pb-8 flex flex-col gap-6">
        {["prompt", "system-prompt", "environment", "firewalls", "volumes"].map(
          (section) => {
            return (
              <div key={section} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-20 w-full" />
              </div>
            );
          },
        )}
      </div>
    </div>
  );
}
