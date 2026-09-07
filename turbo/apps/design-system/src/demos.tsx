import { useState, type ReactNode } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@okouai/ui/components/ui/alert";
import { Button } from "@okouai/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@okouai/ui/components/ui/card";
import { Checkbox } from "@okouai/ui/components/ui/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@okouai/ui/components/ui/command";
import {
  ContextMenu,
  ContextMenuTrigger,
} from "@okouai/ui/components/ui/context-menu";
import { CopyButton } from "@okouai/ui/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@okouai/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui/components/ui/dropdown-menu";
import { ElapsedTime } from "@okouai/ui/components/ui/elapsed-time";
import { Input } from "@okouai/ui/components/ui/input";
import { Kbd, KbdGroup } from "@okouai/ui/components/ui/kbd";
import { MultiSelectCombobox } from "@okouai/ui/components/ui/multi-select-combobox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import { Radio, RadioGroup } from "@okouai/ui/components/ui/radio";
import { RunningIndicator } from "@okouai/ui/components/ui/running-indicator";
import {
  SegmentControl,
  SegmentControlItem,
} from "@okouai/ui/components/ui/segment-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@okouai/ui/components/ui/sheet";
import { ShortcutTooltipGroup } from "@okouai/ui/components/ui/shortcut-tooltip-group";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { Slider } from "@okouai/ui/components/ui/slider";
import { Toaster } from "@okouai/ui/components/ui/sonner";
import { Switch } from "@okouai/ui/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@okouai/ui/components/ui/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@okouai/ui/components/ui/tabs";
import { Textarea } from "@okouai/ui/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
import { toast } from "sonner";
import { Copy, Pause, Play, Settings, Trash2 } from "lucide-react";

export interface Demo {
  /** Matches the file name under packages/ui/src/components/ui. */
  id: string;
  title: string;
  usage?: string;
  /**
   * Rendered as <entry.Demo />, not called, so a demo may hold state the way
   * the real call site does.
   */
  Demo: () => ReactNode;
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

/**
 * The variant matrix is generated from button.tsx's own cva map, so this
 * demo covers what a matrix cannot: the compositions the product relies on.
 */
function ButtonCompositionDemo() {
  return (
    <div className="flex flex-col gap-4">
      <Row>
        <Button>
          <Play />
          Run now
        </Button>
        <Button variant="outline">
          Schedule
          <Settings />
        </Button>
        <Button variant="interrupt" size="icon" aria-label="Pause run">
          <Pause />
        </Button>
        <Button variant="quiet" size="icon-sm" aria-label="Copy id">
          <Copy />
        </Button>
      </Row>
      <Row>
        <Button disabled>Disabled</Button>
        <Button variant="outline" disabled>
          Disabled
        </Button>
        <Button
          showTooltip
          aria-label="Delete agent"
          variant="destructive"
          size="icon"
        >
          <Trash2 />
        </Button>
      </Row>
    </div>
  );
}

const COMBOBOX_OPTIONS = [
  { value: "github", label: "GitHub" },
  { value: "slack", label: "Slack" },
  { value: "notion", label: "Notion" },
  { value: "stripe", label: "Stripe" },
];

export const DEMOS: Demo[] = [
  {
    id: "button",
    title: "Button",
    usage:
      "Every variant and size is rendered from the component's own cva map.",
    Demo: ButtonCompositionDemo,
  },
  {
    id: "alert",
    title: "Alert",
    usage:
      "Inline, non-blocking. Deep-imported by five pages but absent from the package barrel.",
    Demo: () => {
      return (
        <div className="flex max-w-xl flex-col gap-3">
          <Alert>
            <AlertTitle>Runner draining</AlertTitle>
            <AlertDescription>
              Existing runs finish before the old version stops.
            </AlertDescription>
          </Alert>
          <Alert variant="destructive">
            <AlertTitle>Connector disconnected</AlertTitle>
            <AlertDescription>
              Reconnect Slack to resume scheduled posts.
            </AlertDescription>
          </Alert>
        </div>
      );
    },
  },
  {
    id: "card",
    title: "Card",
    Demo: () => {
      return (
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Weekly digest</CardTitle>
            <CardDescription>Runs every Monday at 09:30.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Last run finished in 42s and posted to #all-vm0.
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Run now</Button>
            <Button size="sm" variant="outline">
              Edit
            </Button>
          </CardFooter>
        </Card>
      );
    },
  },
  {
    id: "checkbox",
    title: "Checkbox",
    Demo: function CheckboxDemo() {
      const [checked, setChecked] = useState(true);
      return (
        <Row>
          <Checkbox
            checked={checked}
            onCheckedChange={(next) => {
              return setChecked(next === true);
            }}
          />
          <Checkbox checked={false} />
          <Checkbox checked disabled />
          <Checkbox checked={false} disabled />
        </Row>
      );
    },
  },
  {
    id: "command",
    title: "Command",
    usage: "Built on Base UI's Autocomplete. Backs the ⌘K palette.",
    Demo: () => {
      return (
        <Command className="max-w-sm rounded-xl border-[0.7px] border-[hsl(var(--gray-400))]">
          <CommandInput placeholder="Search agents…" />
          <CommandList>
            <CommandEmpty>Nothing matched.</CommandEmpty>
            <CommandGroup heading="Agents">
              <CommandItem value="inbox">Inbox triage</CommandItem>
              <CommandItem value="digest">Weekly digest</CommandItem>
              <CommandItem value="crm">CRM sync</CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      );
    },
  },
  {
    id: "context-menu",
    title: "Context menu",
    usage: "Right-click the field.",
    Demo: () => {
      return (
        <ContextMenu>
          <ContextMenuTrigger className="flex h-24 w-full max-w-sm items-center justify-center rounded-lg bg-card text-sm text-muted-foreground">
            Right-click here
          </ContextMenuTrigger>
        </ContextMenu>
      );
    },
  },
  {
    id: "copy-button",
    title: "Copy button",
    Demo: () => {
      return (
        <Row>
          <CopyButton text="agt_7f3c91" />
          <span className="font-mono text-[12px] text-muted-foreground">
            agt_7f3c91
          </span>
        </Row>
      );
    },
  },
  {
    id: "dialog",
    title: "Dialog",
    Demo: () => {
      return (
        <Dialog>
          <DialogTrigger
            render={<Button variant="outline">Open dialog</Button>}
          />
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete agent</DialogTitle>
              <DialogDescription>
                This removes the agent and its schedules. Past runs are kept.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline">Cancel</Button>
              <Button variant="destructive">Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      );
    },
  },
  {
    id: "dropdown-menu",
    title: "Dropdown menu",
    Demo: () => {
      return (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="icon" aria-label="Open menu">
                <Settings />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  },
  {
    id: "elapsed-time",
    title: "Elapsed time",
    usage: "Render-prop: it ticks and hands you the milliseconds to format.",
    Demo: function ElapsedDemo() {
      const [start] = useState(() => {
        return Date.now() - 92_000;
      });
      return (
        <ElapsedTime startTime={start}>
          {(ms) => {
            return (
              <span className="font-mono text-sm tabular-nums text-foreground">
                {Math.floor(ms / 1000)}s
              </span>
            );
          }}
        </ElapsedTime>
      );
    },
  },
  {
    id: "input",
    title: "Input",
    Demo: () => {
      return (
        <div className="flex max-w-sm flex-col gap-3">
          <Input placeholder="Agent name" />
          <Input defaultValue="Weekly digest" />
          <Input placeholder="Disabled" disabled />
        </div>
      );
    },
  },
  {
    id: "kbd",
    title: "Kbd",
    Demo: () => {
      return (
        <Row>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <KbdGroup>
            <Kbd>⇧</Kbd>
            <Kbd>⏎</Kbd>
          </KbdGroup>
        </Row>
      );
    },
  },
  {
    id: "multi-select-combobox",
    title: "Multi-select combobox",
    Demo: function ComboboxDemo() {
      const [selected, setSelected] = useState<string[]>(["github"]);
      return (
        <div className="max-w-sm">
          <MultiSelectCombobox
            options={COMBOBOX_OPTIONS}
            selected={selected}
            onChange={setSelected}
            placeholder="Select connectors"
          />
        </div>
      );
    },
  },
  {
    id: "popover",
    title: "Popover",
    Demo: () => {
      return (
        <Popover>
          <PopoverTrigger
            render={<Button variant="outline">Open popover</Button>}
          />
          <PopoverContent className="w-64">
            <p className="text-sm text-muted-foreground">
              Anything hanging off the composer has to live in the top layer, or
              the workspace card clips it.
            </p>
          </PopoverContent>
        </Popover>
      );
    },
  },
  {
    id: "radio",
    title: "Radio",
    Demo: function RadioDemo() {
      const [value, setValue] = useState("cloud");
      return (
        <RadioGroup
          value={value}
          onValueChange={(next) => {
            return setValue(String(next));
          }}
          className="flex flex-col gap-3"
        >
          {["cloud", "desktop", "local"].map((option) => {
            return (
              <label key={option} className="flex items-center gap-2 text-sm">
                <Radio value={option} />
                {option}
              </label>
            );
          })}
        </RadioGroup>
      );
    },
  },
  {
    id: "running-indicator",
    title: "Running indicator",
    usage:
      "Every instance is phase-locked to one wall-clock grid, so rows that mount at different times still pulse together.",
    Demo: () => {
      return (
        <Row>
          <RunningIndicator />
          <RunningIndicator />
          <RunningIndicator />
          <span className="text-sm text-muted-foreground">Running</span>
        </Row>
      );
    },
  },
  {
    id: "segment-control",
    title: "Segment control",
    Demo: function SegmentDemo() {
      const [value, setValue] = useState("all");
      return (
        <div className="flex flex-col gap-4">
          <SegmentControl
            value={value}
            onValueChange={(next) => {
              return setValue(String(next));
            }}
          >
            <SegmentControlItem value="all">All</SegmentControlItem>
            <SegmentControlItem value="mine">Mine</SegmentControlItem>
            <SegmentControlItem value="shared">Shared</SegmentControlItem>
          </SegmentControl>
          <SegmentControl
            variant="plain"
            value={value}
            onValueChange={(next) => {
              return setValue(String(next));
            }}
          >
            <SegmentControlItem value="all">All</SegmentControlItem>
            <SegmentControlItem value="mine">Mine</SegmentControlItem>
            <SegmentControlItem value="shared">Shared</SegmentControlItem>
          </SegmentControl>
        </div>
      );
    },
  },
  {
    id: "select",
    title: "Select",
    Demo: function SelectDemo() {
      const [value, setValue] = useState("opus");
      return (
        <Select
          value={value}
          onValueChange={(next) => {
            return setValue(String(next));
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="opus">Opus 5</SelectItem>
            <SelectItem value="sonnet">Sonnet 5</SelectItem>
            <SelectItem value="haiku">Haiku 4.5</SelectItem>
          </SelectContent>
        </Select>
      );
    },
  },
  {
    id: "sheet",
    title: "Sheet",
    Demo: () => {
      return (
        <Sheet>
          <SheetTrigger
            render={<Button variant="outline">Open sheet</Button>}
          />
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Run details</SheetTitle>
              <SheetDescription>
                The mobile counterpart to a detail pane.
              </SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      );
    },
  },
  {
    id: "shortcut-tooltip-group",
    title: "Shortcut tooltip group",
    Demo: () => {
      return (
        <ShortcutTooltipGroup
          items={[
            {
              shortcut: "mod+enter",
              trigger: (
                <Button variant="quiet" size="icon-sm" aria-label="Run">
                  <Play />
                </Button>
              ),
            },
            {
              shortcut: "mod+.",
              trigger: (
                <Button variant="quiet" size="icon-sm" aria-label="Pause">
                  <Pause />
                </Button>
              ),
            },
          ]}
        />
      );
    },
  },
  {
    id: "skeleton",
    title: "Skeleton",
    Demo: () => {
      return (
        <div className="flex max-w-sm flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      );
    },
  },
  {
    id: "slider",
    title: "Slider",
    Demo: function SliderDemo() {
      const [value, setValue] = useState(6);
      return (
        <div className="flex max-w-sm flex-col gap-6">
          <Slider
            value={value}
            onValueChange={(next) => {
              return setValue(Number(next));
            }}
            min={0}
            max={10}
            step={1}
            aria-label="Timeout"
          />
          <Slider
            value={value}
            onValueChange={(next) => {
              return setValue(Number(next));
            }}
            min={0}
            max={10}
            step={1}
            ticks
            aria-label="Timeout in seconds"
          />
        </div>
      );
    },
  },
  {
    id: "sonner",
    title: "Toaster",
    usage:
      "Deep-imported 49 times — the most reused component in the package, and also missing from the barrel.",
    Demo: () => {
      return (
        <>
          <Toaster />
          <Row>
            <Button
              variant="outline"
              onClick={() => {
                return toast.success("Run queued");
              }}
            >
              Success
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                return toast.error("Connector disconnected");
              }}
            >
              Error
            </Button>
          </Row>
        </>
      );
    },
  },
  {
    id: "switch",
    title: "Switch",
    Demo: function SwitchDemo() {
      const [on, setOn] = useState(true);
      return (
        <Row>
          <Switch checked={on} onCheckedChange={setOn} />
          <Switch checked={false} />
          <Switch checked disabled />
        </Row>
      );
    },
  },
  {
    id: "table",
    title: "Table",
    Demo: () => {
      return (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Last run</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Weekly digest</TableCell>
              <TableCell>Mon 09:30</TableCell>
              <TableCell>42s</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Inbox triage</TableCell>
              <TableCell>Every 15m</TableCell>
              <TableCell>6s</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      );
    },
  },
  {
    id: "tabs",
    title: "Tabs",
    Demo: function TabsDemo() {
      const [tab, setTab] = useState("overview");
      return (
        <Tabs
          value={tab}
          onValueChange={(next) => {
            return setTab(String(next));
          }}
        >
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent
            value="overview"
            className="pt-4 text-sm text-muted-foreground"
          >
            What the agent does and who can run it.
          </TabsContent>
          <TabsContent
            value="runs"
            className="pt-4 text-sm text-muted-foreground"
          >
            Every run, newest first.
          </TabsContent>
          <TabsContent
            value="settings"
            className="pt-4 text-sm text-muted-foreground"
          >
            Model, permissions and schedule.
          </TabsContent>
        </Tabs>
      );
    },
  },
  {
    id: "textarea",
    title: "Textarea",
    Demo: () => {
      return (
        <Textarea
          className="max-w-sm"
          rows={3}
          defaultValue="Summarise this week's inbound and post it to #all-vm0."
        />
      );
    },
  },
  {
    id: "tooltip",
    title: "Tooltip",
    Demo: () => {
      return (
        <TooltipProvider delayDuration={150}>
          <Row>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="quiet" size="icon" aria-label="Copy">
                    <Copy />
                  </Button>
                }
              />
              <TooltipContent>Copy run id</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="quiet" size="icon" aria-label="Delete">
                    <Trash2 />
                  </Button>
                }
              />
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </Row>
        </TooltipProvider>
      );
    },
  },
];
