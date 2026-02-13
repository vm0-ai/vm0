import { cn } from "@vm0/ui/lib/utils";

const AVATAR_COLORS = [
  "bg-orange-500",
  "bg-blue-500",
  "bg-green-500",
  "bg-purple-500",
  "bg-pink-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-amber-500",
] as const;

function getColorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index] ?? AVATAR_COLORS[0];
}

interface AgentAvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLASSES = {
  sm: "h-8 w-8 text-sm",
  md: "h-10 w-10 text-lg",
  lg: "h-14 w-14 text-2xl",
} as const;

export function AgentAvatar({
  name,
  size = "md",
  className,
}: AgentAvatarProps) {
  const initial = name.charAt(0).toUpperCase();
  const bgColor = getColorForName(name);

  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-xl font-semibold text-white shrink-0",
        bgColor,
        SIZE_CLASSES[size],
        className,
      )}
    >
      {initial}
    </div>
  );
}
