import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  AlarmClockIcon,
  Alert01Icon,
  AlertDiamondIcon,
  ArrowDataTransferHorizontalIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowLeftDoubleIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowRightDoubleIcon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  ArrowUpDoubleIcon,
  ArrowUpRight01Icon,
  AttachmentIcon,
  BluetoothIcon,
  BubbleChatIcon,
  Bug01Icon,
  Building01Icon,
  Calendar03Icon,
  Cancel01Icon,
  ChartBarLineIcon,
  ChartLineData01Icon,
  CheckmarkCircle01Icon,
  CheckmarkCircle02Icon,
  Chemistry01Icon,
  CircleArrowDataTransferDiagonalIcon,
  Clock01Icon,
  Coins01Icon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  CpuIcon,
  CreditCardIcon,
  CrownIcon,
  DatabaseExportIcon,
  Delete02Icon,
  DiceIcon,
  Download01Icon,
  File01Icon,
  FileEditIcon,
  FileMusicIcon,
  FilterHorizontalIcon,
  FilterIcon,
  GiftIcon,
  Globe02Icon,
  GoogleDriveIcon,
  GridIcon,
  HandGripIcon,
  Image01Icon,
  InvoiceIcon,
  Key01Icon,
  KeyboardIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  LinkSquare01Icon,
  Loading02Icon,
  Loading03Icon,
  LockIcon,
  Logout01Icon,
  MagicWand01Icon,
  Mail01Icon,
  Menu01Icon,
  Mic01Icon,
  Moon01Icon,
  MoreHorizontalIcon,
  MoreVerticalIcon,
  Move01Icon,
  PackageIcon,
  PaintBoardIcon,
  PencilEdit01Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  PlugSocketIcon,
  PlusSignIcon,
  QuoteUpIcon,
  RecordIcon,
  RefreshIcon,
  ReloadIcon,
  RepeatIcon,
  RoboticIcon,
  Search01Icon,
  SecurityBlockIcon,
  SecurityCheckIcon,
  Settings01Icon,
  Share01Icon,
  Shield01Icon,
  SidebarLeftIcon,
  SlackIcon,
  SourceCodeIcon,
  SparklesIcon,
  SquareArrowExpand01Icon,
  StopIcon,
  Sun01Icon,
  TextBoldIcon,
  TextItalicIcon,
  TextNumberSignIcon,
  TextStrikethroughIcon,
  Tick02Icon,
  ToolsIcon,
  Upload01Icon,
  UserAdd01Icon,
  UserCircleIcon,
  UserGroupIcon,
  UserIcon,
  VideoReplayIcon,
  ViewIcon,
  VolumeHighIcon,
  Wifi01Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons";
import { forwardRef, type SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "stroke" | "strokeWidth"> & {
  size?: number | string;
  strokeWidth?: number;
  /** tabler-compat alias for strokeWidth */
  stroke?: number;
};

function makeIcon(svg: IconSvgElement, displayName: string) {
  const Component = forwardRef<SVGSVGElement, IconProps>(
    ({ stroke, strokeWidth, size, ...rest }, ref) => {
      return (
        <HugeiconsIcon
          ref={ref}
          icon={svg}
          size={size}
          strokeWidth={strokeWidth ?? stroke}
          {...rest}
        />
      );
    },
  );
  Component.displayName = displayName;
  return Component;
}

export const IconAdjustmentsHorizontal = makeIcon(
  FilterHorizontalIcon,
  "IconAdjustmentsHorizontal",
);
export const IconAlertCircle = makeIcon(Alert01Icon, "IconAlertCircle");
export const IconAlertTriangle = makeIcon(
  AlertDiamondIcon,
  "IconAlertTriangle",
);
export const IconArrowBackUp = makeIcon(
  ArrowTurnBackwardIcon,
  "IconArrowBackUp",
);
export const IconArrowBarToUp = makeIcon(ArrowUpDoubleIcon, "IconArrowBarToUp");
export const IconArrowLeft = makeIcon(ArrowLeft02Icon, "IconArrowLeft");
export const IconArrowRight = makeIcon(ArrowRight02Icon, "IconArrowRight");
export const IconArrowUp = makeIcon(ArrowUp02Icon, "IconArrowUp");
export const IconArrowUpRight = makeIcon(
  ArrowUpRight01Icon,
  "IconArrowUpRight",
);
export const IconArrowsMove = makeIcon(Move01Icon, "IconArrowsMove");
export const IconBan = makeIcon(Cancel01Icon, "IconBan");
export const IconBlockquote = makeIcon(QuoteUpIcon, "IconBlockquote");
export const IconBluetooth = makeIcon(BluetoothIcon, "IconBluetooth");
export const IconBold = makeIcon(TextBoldIcon, "IconBold");
export const IconBrandGoogleDrive = makeIcon(
  GoogleDriveIcon,
  "IconBrandGoogleDrive",
);
export const IconBrandSlack = makeIcon(SlackIcon, "IconBrandSlack");
export const IconBug = makeIcon(Bug01Icon, "IconBug");
export const IconBuilding = makeIcon(Building01Icon, "IconBuilding");
export const IconCalendar = makeIcon(Calendar03Icon, "IconCalendar");
export const IconChartBar = makeIcon(ChartBarLineIcon, "IconChartBar");
export const IconChartLine = makeIcon(ChartLineData01Icon, "IconChartLine");
export const IconCheck = makeIcon(Tick02Icon, "IconCheck");
export const IconChevronDown = makeIcon(ArrowDown01Icon, "IconChevronDown");
export const IconChevronLeft = makeIcon(ArrowLeft01Icon, "IconChevronLeft");
export const IconChevronRight = makeIcon(ArrowRight01Icon, "IconChevronRight");
export const IconChevronUp = makeIcon(ArrowUp01Icon, "IconChevronUp");
export const IconChevronsLeft = makeIcon(
  ArrowLeftDoubleIcon,
  "IconChevronsLeft",
);
export const IconChevronsRight = makeIcon(
  ArrowRightDoubleIcon,
  "IconChevronsRight",
);
export const IconCircleCheck = makeIcon(
  CheckmarkCircle01Icon,
  "IconCircleCheck",
);
export const IconCircleCheckFilled = makeIcon(
  CheckmarkCircle02Icon,
  "IconCircleCheckFilled",
);
export const IconCircleDashed = makeIcon(
  CircleArrowDataTransferDiagonalIcon,
  "IconCircleDashed",
);
export const IconCircleDot = makeIcon(RecordIcon, "IconCircleDot");
export const IconCircleX = makeIcon(Cancel01Icon, "IconCircleX");
export const IconClock = makeIcon(Clock01Icon, "IconClock");
export const IconClockExclamation = makeIcon(
  AlarmClockIcon,
  "IconClockExclamation",
);
export const IconCode = makeIcon(SourceCodeIcon, "IconCode");
export const IconCoins = makeIcon(Coins01Icon, "IconCoins");
export const IconCopy = makeIcon(Copy01Icon, "IconCopy");
export const IconCpu = makeIcon(CpuIcon, "IconCpu");
export const IconCreditCard = makeIcon(CreditCardIcon, "IconCreditCard");
export const IconCrown = makeIcon(CrownIcon, "IconCrown");
export const IconDatabaseExport = makeIcon(
  DatabaseExportIcon,
  "IconDatabaseExport",
);
export const IconDeviceDesktop = makeIcon(ComputerIcon, "IconDeviceDesktop");
export const IconDice = makeIcon(DiceIcon, "IconDice");
export const IconDots = makeIcon(MoreHorizontalIcon, "IconDots");
export const IconDotsVertical = makeIcon(MoreVerticalIcon, "IconDotsVertical");
export const IconDownload = makeIcon(Download01Icon, "IconDownload");
export const IconEdit = makeIcon(PencilEdit01Icon, "IconEdit");
export const IconExternalLink = makeIcon(LinkSquare01Icon, "IconExternalLink");
export const IconEye = makeIcon(ViewIcon, "IconEye");
export const IconFile = makeIcon(File01Icon, "IconFile");
export const IconFileInvoice = makeIcon(InvoiceIcon, "IconFileInvoice");
export const IconFileMusic = makeIcon(FileMusicIcon, "IconFileMusic");
export const IconFileText = makeIcon(FileEditIcon, "IconFileText");
export const IconFilter = makeIcon(FilterIcon, "IconFilter");
export const IconFlask = makeIcon(Chemistry01Icon, "IconFlask");
export const IconGift = makeIcon(GiftIcon, "IconGift");
export const IconH1 = makeIcon(TextNumberSignIcon, "IconH1");
export const IconH2 = makeIcon(TextNumberSignIcon, "IconH2");
export const IconH3 = makeIcon(TextNumberSignIcon, "IconH3");
export const IconHandStop = makeIcon(HandGripIcon, "IconHandStop");
export const IconItalic = makeIcon(TextItalicIcon, "IconItalic");
export const IconKey = makeIcon(Key01Icon, "IconKey");
export const IconKeyboard = makeIcon(KeyboardIcon, "IconKeyboard");
export const IconLayoutGrid = makeIcon(GridIcon, "IconLayoutGrid");
export const IconLayoutSidebarLeftCollapse = makeIcon(
  SidebarLeftIcon,
  "IconLayoutSidebarLeftCollapse",
);
export const IconLink = makeIcon(Link01Icon, "IconLink");
export const IconList = makeIcon(LeftToRightListBulletIcon, "IconList");
export const IconListNumbers = makeIcon(
  LeftToRightListNumberIcon,
  "IconListNumbers",
);
export const IconLoader = makeIcon(Loading02Icon, "IconLoader");
export const IconLoader2 = makeIcon(Loading03Icon, "IconLoader2");
export const IconLock = makeIcon(LockIcon, "IconLock");
export const IconLogout = makeIcon(Logout01Icon, "IconLogout");
export const IconMail = makeIcon(Mail01Icon, "IconMail");
export const IconMenu2 = makeIcon(Menu01Icon, "IconMenu2");
export const IconMessageCircle = makeIcon(BubbleChatIcon, "IconMessageCircle");
export const IconMicrophone = makeIcon(Mic01Icon, "IconMicrophone");
export const IconMoon = makeIcon(Moon01Icon, "IconMoon");
export const IconPackage = makeIcon(PackageIcon, "IconPackage");
export const IconPalette = makeIcon(PaintBoardIcon, "IconPalette");
export const IconPaperclip = makeIcon(AttachmentIcon, "IconPaperclip");
export const IconPencil = makeIcon(PencilEdit02Icon, "IconPencil");
export const IconPhoto = makeIcon(Image01Icon, "IconPhoto");
export const IconPin = makeIcon(PinIcon, "IconPin");
export const IconPinnedOff = makeIcon(PinOffIcon, "IconPinnedOff");
export const IconPlayerPlay = makeIcon(PlayIcon, "IconPlayerPlay");
export const IconPlayerStop = makeIcon(StopIcon, "IconPlayerStop");
export const IconPlug = makeIcon(PlugSocketIcon, "IconPlug");
export const IconPlugConnected = makeIcon(PlugSocketIcon, "IconPlugConnected");
export const IconPlus = makeIcon(PlusSignIcon, "IconPlus");
export const IconRefresh = makeIcon(RefreshIcon, "IconRefresh");
export const IconRepeat = makeIcon(RepeatIcon, "IconRepeat");
export const IconRobot = makeIcon(RoboticIcon, "IconRobot");
export const IconRotateClockwise2 = makeIcon(
  ReloadIcon,
  "IconRotateClockwise2",
);
export const IconSearch = makeIcon(Search01Icon, "IconSearch");
export const IconSettings = makeIcon(Settings01Icon, "IconSettings");
export const IconShare2 = makeIcon(Share01Icon, "IconShare2");
export const IconShield = makeIcon(Shield01Icon, "IconShield");
export const IconShieldCheck = makeIcon(SecurityCheckIcon, "IconShieldCheck");
export const IconShieldOff = makeIcon(SecurityBlockIcon, "IconShieldOff");
export const IconSparkles = makeIcon(SparklesIcon, "IconSparkles");
export const IconSquarePlus = makeIcon(
  SquareArrowExpand01Icon,
  "IconSquarePlus",
);
export const IconStrikethrough = makeIcon(
  TextStrikethroughIcon,
  "IconStrikethrough",
);
export const IconSun = makeIcon(Sun01Icon, "IconSun");
export const IconSwitchHorizontal = makeIcon(
  ArrowDataTransferHorizontalIcon,
  "IconSwitchHorizontal",
);
export const IconTerminal = makeIcon(ComputerTerminal01Icon, "IconTerminal");
export const IconTool = makeIcon(ToolsIcon, "IconTool");
export const IconTrash = makeIcon(Delete02Icon, "IconTrash");
export const IconUpload = makeIcon(Upload01Icon, "IconUpload");
export const IconUser = makeIcon(UserIcon, "IconUser");
export const IconUserCircle = makeIcon(UserCircleIcon, "IconUserCircle");
export const IconUserPlus = makeIcon(UserAdd01Icon, "IconUserPlus");
export const IconUsers = makeIcon(UserGroupIcon, "IconUsers");
export const IconVideo = makeIcon(VideoReplayIcon, "IconVideo");
export const IconVolume2 = makeIcon(VolumeHighIcon, "IconVolume2");
export const IconWand = makeIcon(MagicWand01Icon, "IconWand");
export const IconWifi = makeIcon(Wifi01Icon, "IconWifi");
export const IconWorldWww = makeIcon(Globe02Icon, "IconWorldWww");
export const IconX = makeIcon(Cancel01Icon, "IconX");
export const IconZoomIn = makeIcon(ZoomInAreaIcon, "IconZoomIn");
export const IconZoomOut = makeIcon(ZoomOutAreaIcon, "IconZoomOut");
export const IconZoomReset = makeIcon(Search01Icon, "IconZoomReset");
