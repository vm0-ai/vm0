// Shared presentational helpers for the workflow list, index, and detail views.
import type {
  WorkflowFileMetadata,
  ZeroWorkflowSummary,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  IconFile,
  IconFolderOpen,
  IconLock,
  IconWorld,
} from "@tabler/icons-react";
import { cn } from "@vm0/ui";

const LEADING_YAML_FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FILE_TREE_BASE_PADDING_PX = 8;
const FILE_TREE_INDENT_PX = 16;

type WorkflowFileTreeNode =
  | WorkflowFileTreeFolderNode
  | WorkflowFileTreeFileNode;

interface WorkflowFileTreeFolderNode {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: readonly WorkflowFileTreeNode[];
}

interface WorkflowFileTreeFileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

type MutableWorkflowFileTreeNode =
  | MutableWorkflowFileTreeFolderNode
  | WorkflowFileTreeFileNode;

interface MutableWorkflowFileTreeFolderNode {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: MutableWorkflowFileTreeNode[];
  readonly folders: Map<string, MutableWorkflowFileTreeFolderNode>;
}

export function workflowTitle(workflow: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return workflow.displayName ?? workflow.name;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function stripMarkdownFrontmatter(content: string): string {
  return content.replace(LEADING_YAML_FRONTMATTER_PATTERN, "");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  const mib = kib / 1024;
  return `${mib.toFixed(1)} MiB`;
}

export function agentLabel(workflow: {
  readonly agentDisplayName: string | null;
  readonly agentName: string | null;
  readonly agentId: string;
}): string {
  return workflow.agentDisplayName ?? workflow.agentName ?? workflow.agentId;
}

export function triggerKindLabel(
  kind: ZeroWorkflowTriggerSummary["kind"],
): string {
  return kind === "schedule" ? "Schedule trigger" : "Event trigger";
}

function filePathSegments(path: string): readonly string[] {
  return path.split("/").filter((segment) => {
    return segment.length > 0;
  });
}

function toWorkflowFileTreeNode(
  node: MutableWorkflowFileTreeNode,
): WorkflowFileTreeNode {
  if (node.kind === "file") {
    return node;
  }

  return {
    kind: "folder",
    name: node.name,
    path: node.path,
    children: node.children.map(toWorkflowFileTreeNode),
  };
}

export function buildWorkflowFileTree(
  files: readonly WorkflowFileMetadata[],
): readonly WorkflowFileTreeNode[] {
  const root: MutableWorkflowFileTreeFolderNode = {
    kind: "folder",
    name: "",
    path: "",
    children: [],
    folders: new Map(),
  };

  for (const file of files) {
    const segments = filePathSegments(file.path);
    const fileName = segments.at(-1);
    if (!fileName) {
      continue;
    }

    let currentFolder = root;
    for (const folderName of segments.slice(0, -1)) {
      const folderPath = currentFolder.path
        ? `${currentFolder.path}/${folderName}`
        : folderName;
      const existingFolder = currentFolder.folders.get(folderName);
      if (existingFolder) {
        currentFolder = existingFolder;
        continue;
      }

      const folder: MutableWorkflowFileTreeFolderNode = {
        kind: "folder",
        name: folderName,
        path: folderPath,
        children: [],
        folders: new Map(),
      };
      currentFolder.folders.set(folderName, folder);
      currentFolder.children.push(folder);
      currentFolder = folder;
    }

    currentFolder.children.push({
      kind: "file",
      name: fileName,
      path: file.path,
      size: file.size,
    });
  }

  return root.children.map(toWorkflowFileTreeNode);
}

export function VisibilityBadge({
  visibility,
  requestToPublish,
}: {
  readonly visibility: ZeroWorkflowSummary["visibility"];
  readonly requestToPublish?: boolean;
}) {
  const isPrivate = visibility === "private";
  const Icon = isPrivate ? IconLock : IconWorld;
  const label = isPrivate && requestToPublish ? "pending review" : visibility;

  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border/60 px-2 text-xs font-medium capitalize text-muted-foreground">
      <Icon size={12} stroke={1.5} className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function WorkflowFileTree({
  nodes,
  depth,
  selectedPath,
  onSelectFile,
}: {
  readonly nodes: readonly WorkflowFileTreeNode[];
  readonly depth: number;
  readonly selectedPath: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {nodes.map((node) => {
        if (node.kind === "folder") {
          return (
            <div key={node.path} className="min-w-0">
              <div
                className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-foreground"
                style={{
                  paddingLeft:
                    FILE_TREE_BASE_PADDING_PX + depth * FILE_TREE_INDENT_PX,
                }}
              >
                <IconFolderOpen
                  size={14}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 truncate text-xs font-medium">
                  {node.name}
                </span>
              </div>
              <WorkflowFileTree
                nodes={node.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            </div>
          );
        }

        const selected = node.path === selectedPath;
        return (
          <button
            key={node.path}
            type="button"
            aria-label={`Open ${node.path}`}
            aria-pressed={selected}
            className={cn(
              "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md py-1.5 pr-2 text-left transition-colors",
              selected
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/70",
            )}
            style={{
              paddingLeft:
                FILE_TREE_BASE_PADDING_PX + depth * FILE_TREE_INDENT_PX,
            }}
            onClick={() => {
              onSelectFile(node.path);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <IconFile
                size={14}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate text-xs">{node.name}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatBytes(node.size)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
