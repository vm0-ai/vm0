import { forwardRef } from "react";
import type { SVGProps, ForwardRefExoticComponent, RefAttributes } from "react";
import {
  Alarm,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Attachment,
  Bold,
  Bug,
  Building,
  Calendar,
  ChatBubble,
  ChatLines,
  Check,
  CheckCircle,
  CheckCircleSolid,
  Circle,
  CircleSpark,
  Clock,
  Code,
  Coins,
  Computer,
  Copy,
  OpenSelectHandGesture,
  Cpu,
  CreditCard,
  Crown,
  DatabaseExport,
  DiceOne,
  Download,
  Drag,
  EditPencil,
  Eye,
  FastArrowLeft,
  FastArrowRight,
  Filter,
  Flask,
  Gift,
  Globe,
  GoogleDrive,
  GraphUp,
  HalfMoon,
  Group,
  Italic,
  Key,
  KeyCommand,
  Link,
  List,
  Lock,
  LogOut,
  MagicWand,
  Mail,
  MediaImage,
  Menu,
  Microphone,
  MoreHoriz,
  MoreVert,
  MusicNote,
  NavArrowDown,
  NavArrowLeft,
  NavArrowRight,
  NavArrowUp,
  Notes,
  NumberedListLeft,
  OpenNewWindow,
  Package,
  Page,
  PageUp,
  Palette,
  Pin,
  PinSlash,
  Play,
  Plus,
  PlugTypeA,
  PlusSquare,
  Prohibition,
  Quote,
  Refresh,
  RefreshCircle,
  RefreshDouble,
  Repeat,
  RotateCameraRight,
  Search,
  Settings,
  ShareAndroid,
  Shield,
  ShieldCheck,
  ShieldXmark,
  SidebarCollapse,
  SoundHigh,
  Sparks,
  Square,
  StatsReport,
  Strikethrough,
  SunLight,
  SwitchOff,
  Terminal,
  Text,
  Trash,
  Undo,
  Upload,
  User,
  UserCircle,
  UserPlus,
  VideoCamera,
  ViewGrid,
  WarningCircle,
  WarningTriangle,
  Wrench,
  Xmark,
  XmarkCircle,
  ZoomIn,
  ZoomOut,
} from "iconoir-react";

type IconoirIcon = ForwardRefExoticComponent<
  Omit<SVGProps<SVGSVGElement>, "ref"> & RefAttributes<SVGSVGElement>
>;

type TablerProps = Omit<SVGProps<SVGSVGElement>, "stroke"> & {
  size?: number | string;
  stroke?: number | string;
};

function withTablerProps(Icon: IconoirIcon) {
  const Component = forwardRef<SVGSVGElement, TablerProps>(
    ({ size, stroke, strokeWidth, ...props }, ref) => {
      return (
        <Icon
          ref={ref}
          width={size}
          height={size}
          strokeWidth={stroke ?? strokeWidth}
          {...props}
        />
      );
    },
  );
  Component.displayName = Icon.displayName ?? "Icon";
  return Component;
}

export const IconAdjustmentsHorizontal = withTablerProps(Settings);
export const IconAlertCircle = withTablerProps(WarningCircle);
export const IconAlertTriangle = withTablerProps(WarningTriangle);
export const IconArrowBackUp = withTablerProps(Undo);
export const IconArrowBarToUp = withTablerProps(PageUp);
export const IconArrowLeft = withTablerProps(ArrowLeft);
export const IconArrowRight = withTablerProps(ArrowRight);
export const IconArrowsMove = withTablerProps(Drag);
export const IconArrowUp = withTablerProps(ArrowUp);
export const IconArrowUpRight = withTablerProps(ArrowUpRight);
export const IconBan = withTablerProps(Prohibition);
export const IconBlockquote = withTablerProps(Quote);
export const IconBold = withTablerProps(Bold);
export const IconBrandGoogleDrive = withTablerProps(GoogleDrive);
export const IconBrandSlack = withTablerProps(ChatLines);
export const IconBug = withTablerProps(Bug);
export const IconBuilding = withTablerProps(Building);
export const IconCalendar = withTablerProps(Calendar);
export const IconChartBar = withTablerProps(GraphUp);
export const IconChartLine = withTablerProps(StatsReport);
export const IconCheck = withTablerProps(Check);
export const IconChevronDown = withTablerProps(NavArrowDown);
export const IconChevronLeft = withTablerProps(NavArrowLeft);
export const IconChevronRight = withTablerProps(NavArrowRight);
export const IconChevronUp = withTablerProps(NavArrowUp);
export const IconChevronsLeft = withTablerProps(FastArrowLeft);
export const IconChevronsRight = withTablerProps(FastArrowRight);
export const IconCircleCheck = withTablerProps(CheckCircle);
export const IconCircleCheckFilled = withTablerProps(CheckCircleSolid);
export const IconCircleDashed = withTablerProps(Circle);
export const IconCircleDot = withTablerProps(CircleSpark);
export const IconCircleX = withTablerProps(XmarkCircle);
export const IconClock = withTablerProps(Clock);
export const IconClockExclamation = withTablerProps(Alarm);
export const IconCode = withTablerProps(Code);
export const IconCoins = withTablerProps(Coins);
export const IconCopy = withTablerProps(Copy);
export const IconCpu = withTablerProps(Cpu);
export const IconCreditCard = withTablerProps(CreditCard);
export const IconCrown = withTablerProps(Crown);
export const IconDatabaseExport = withTablerProps(DatabaseExport);
export const IconDeviceDesktop = withTablerProps(Computer);
export const IconDice = withTablerProps(DiceOne);
export const IconDots = withTablerProps(MoreHoriz);
export const IconDotsVertical = withTablerProps(MoreVert);
export const IconDownload = withTablerProps(Download);
export const IconEdit = withTablerProps(EditPencil);
export const IconExternalLink = withTablerProps(OpenNewWindow);
export const IconEye = withTablerProps(Eye);
export const IconFile = withTablerProps(Notes);
export const IconFileInvoice = withTablerProps(Page);
export const IconFileMusic = withTablerProps(MusicNote);
export const IconFileText = withTablerProps(Page);
export const IconFilter = withTablerProps(Filter);
export const IconFlask = withTablerProps(Flask);
export const IconGift = withTablerProps(Gift);
export const IconH1 = withTablerProps(Text);
export const IconH2 = withTablerProps(Text);
export const IconH3 = withTablerProps(Text);
export const IconHandStop = withTablerProps(OpenSelectHandGesture);
export const IconItalic = withTablerProps(Italic);
export const IconKey = withTablerProps(Key);
export const IconKeyboard = withTablerProps(KeyCommand);
export const IconLayoutGrid = withTablerProps(ViewGrid);
export const IconLayoutSidebarLeftCollapse = withTablerProps(SidebarCollapse);
export const IconLink = withTablerProps(Link);
export const IconList = withTablerProps(List);
export const IconListNumbers = withTablerProps(NumberedListLeft);
export const IconLoader = withTablerProps(Refresh);
export const IconLoader2 = withTablerProps(RefreshDouble);
export const IconLock = withTablerProps(Lock);
export const IconLogout = withTablerProps(LogOut);
export const IconMail = withTablerProps(Mail);
export const IconMenu2 = withTablerProps(Menu);
export const IconMessageCircle = withTablerProps(ChatBubble);
export const IconMicrophone = withTablerProps(Microphone);
export const IconMoon = withTablerProps(HalfMoon);
export const IconPackage = withTablerProps(Package);
export const IconPalette = withTablerProps(Palette);
export const IconPaperclip = withTablerProps(Attachment);
export const IconPencil = withTablerProps(EditPencil);
export const IconPhoto = withTablerProps(MediaImage);
export const IconPin = withTablerProps(Pin);
export const IconPinnedOff = withTablerProps(PinSlash);
export const IconPlayerPlay = withTablerProps(Play);
export const IconPlayerStop = withTablerProps(Square);
export const IconPlug = withTablerProps(PlugTypeA);
export const IconPlugConnected = withTablerProps(PlugTypeA);
export const IconPlus = withTablerProps(Plus);
export const IconRefresh = withTablerProps(RefreshCircle);
export const IconRepeat = withTablerProps(Repeat);
export const IconRobot = withTablerProps(Cpu);
export const IconRotateClockwise2 = withTablerProps(RotateCameraRight);
export const IconSearch = withTablerProps(Search);
export const IconSettings = withTablerProps(Settings);
export const IconShare2 = withTablerProps(ShareAndroid);
export const IconShield = withTablerProps(Shield);
export const IconShieldCheck = withTablerProps(ShieldCheck);
export const IconShieldOff = withTablerProps(ShieldXmark);
export const IconSparkles = withTablerProps(Sparks);
export const IconSquarePlus = withTablerProps(PlusSquare);
export const IconStrikethrough = withTablerProps(Strikethrough);
export const IconSun = withTablerProps(SunLight);
export const IconSwitchHorizontal = withTablerProps(SwitchOff);
export const IconTerminal = withTablerProps(Terminal);
export const IconTool = withTablerProps(Wrench);
export const IconTrash = withTablerProps(Trash);
export const IconUpload = withTablerProps(Upload);
export const IconUser = withTablerProps(User);
export const IconUserCircle = withTablerProps(UserCircle);
export const IconUserPlus = withTablerProps(UserPlus);
export const IconUsers = withTablerProps(Group);
export const IconVideo = withTablerProps(VideoCamera);
export const IconVolume2 = withTablerProps(SoundHigh);
export const IconWand = withTablerProps(MagicWand);
export const IconWorldWww = withTablerProps(Globe);
export const IconX = withTablerProps(Xmark);
export const IconZoomIn = withTablerProps(ZoomIn);
export const IconZoomOut = withTablerProps(ZoomOut);
export const IconZoomReset = withTablerProps(ZoomIn);
