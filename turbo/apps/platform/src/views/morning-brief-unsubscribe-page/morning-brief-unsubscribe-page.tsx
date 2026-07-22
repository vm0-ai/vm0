import type { ReactNode } from "react";
import { useGet } from "ccstate-react";
import { IconCheck, IconLoader2, IconX } from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  morningBriefUnsubscribeStatus$,
  type MorningBriefUnsubscribeStatus,
} from "../../signals/morning-brief-unsubscribe/morning-brief-unsubscribe-signals.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import { VM0Logo } from "../components/vm0-logo.tsx";

interface CardInfo {
  title: string;
  body: string;
}

function resolveCard(status: MorningBriefUnsubscribeStatus): CardInfo {
  if (status === "unsubscribed") {
    return {
      title: "Morning Brief turned off",
      body: "You will no longer receive the daily Morning Brief email. You can turn it back on any time in Settings.",
    };
  }
  return {
    title: "This link is invalid",
    body: "The unsubscribe link is invalid or incomplete. Open the latest Morning Brief email and use its unsubscribe link, or manage the preference in Settings.",
  };
}

function CardIcon({
  status,
}: {
  status: MorningBriefUnsubscribeStatus;
}): ReactNode {
  if (status === "unsubscribed") {
    return <IconCheck size={40} className="text-green-600 opacity-80" />;
  }
  return <IconX size={40} className="text-destructive opacity-70" />;
}

export function MorningBriefUnsubscribePage() {
  const status = useGet(morningBriefUnsubscribeStatus$);

  if (!status) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <IconLoader2 size={40} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const info = resolveCard(status);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-[500px] max-w-full flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-[50px] py-12">
        <VM0Logo />
        <div className="flex flex-col items-center gap-4">
          <CardIcon status={status} />
          <p className="text-center text-lg font-medium leading-7 text-foreground">
            {info.title}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            {info.body}
          </p>
        </div>
        <Button className="w-full" asChild>
          <Link pathname={ROUTES.settings}>Manage preferences</Link>
        </Button>
      </div>
    </div>
  );
}
