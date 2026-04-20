import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui";
import type { RunContextResponse } from "@vm0/core";

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
    <Table className="table-fixed">
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
              <TableCell className="font-mono text-xs break-all">
                {item.mountPath}
              </TableCell>
              <TableCell className="font-mono text-xs break-all">
                {item.vasStorageName}
              </TableCell>
              <TableCell className="font-mono text-xs break-all">
                {item.vasVersionId}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function FeatureFlagsSection({
  flags,
}: {
  flags: Record<string, boolean> | null | undefined;
}) {
  if (!flags || Object.keys(flags).length === 0) {
    return null;
  }
  const sorted = Object.entries(flags).sort(([, a], [, b]) => {
    return a === b ? 0 : a ? -1 : 1;
  });
  return (
    <section>
      <SectionHeader title="Feature Flags" />
      <div className="flex flex-wrap gap-1.5">
        {sorted.map(([name, enabled]) => {
          return (
            <span
              key={name}
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-mono ${
                enabled
                  ? "bg-muted/50"
                  : "bg-transparent text-muted-foreground line-through"
              }`}
            >
              {name}
            </span>
          );
        })}
      </div>
    </section>
  );
}

export function ContextContent({ context }: { context: RunContextResponse }) {
  return (
    <div className="flex flex-col gap-6 pb-8">
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

      {/* Run ID */}
      <section>
        <SectionHeader title="Run ID" />
        <p className="text-sm font-mono text-muted-foreground">
          {context.runId}
        </p>
      </section>

      {/* Session */}
      {context.sessionId && (
        <section>
          <SectionHeader title="Session" />
          <p className="text-sm font-mono text-muted-foreground">
            {context.sessionId}
          </p>
        </section>
      )}

      {/* Feature Flags */}
      <FeatureFlagsSection flags={context.featureFlags} />

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

      {/* Network Policies */}
      {context.networkPolicies &&
        Object.keys(context.networkPolicies).length > 0 && (
          <section>
            <SectionHeader title="Network Policies" />
            <CodeBlock
              value={JSON.stringify(context.networkPolicies, null, 2)}
            />
          </section>
        )}

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
  );
}
