import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  addNotificationLoadingKey$,
  notificationLoadingKeys$,
  notificationPreferences$,
  removeNotificationLoadingKey$,
  updateNotificationPreference$,
} from "../../../../signals/zero-page/settings/notification-settings.ts";
import { LoadingSwitch } from "../../../components/loading-switch.tsx";
import emailIcon from "./icons/email.svg";
import slackIcon from "./icons/slack.svg";

export function NotificationSettings() {
  const preferences = useLastResolved(notificationPreferences$);
  const updatePreference = useSet(updateNotificationPreference$);

  const loadingKeys = useGet(notificationLoadingKeys$);
  const addLoadingKey = useSet(addNotificationLoadingKey$);
  const removeLoadingKey = useSet(removeNotificationLoadingKey$);

  const handleToggle = (key: string, update: Record<string, boolean>) => {
    addLoadingKey(key);
    updatePreference(update)
      .finally(() => {
        removeLoadingKey(key);
      })
      .catch(() => toast.error("Failed to update preference"));
  };

  if (!preferences) {
    return (
      <div className="flex flex-col">
        <Skeleton className="h-[76px] w-full rounded-t-xl rounded-b-none" />
        <Skeleton className="h-[76px] w-full rounded-t-none rounded-b-xl border-t border-background" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Choose how you get notified when scheduled agent runs complete or fail.
      </p>
      <div className="flex flex-col">
        <div
          className="flex items-center gap-4 bg-card p-4 rounded-t-xl"
          style={{
            border: "0.7px solid hsl(var(--gray-400))",
            borderBottom: "none",
          }}
        >
          <div className="shrink-0">
            <img
              src={emailIcon}
              width={22}
              height={22}
              alt=""
              className="opacity-50 zero-icon-mono"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              Email Notifications
            </div>
            <div className="text-sm text-muted-foreground">
              Receive an email when a scheduled agent run completes or fails.
            </div>
          </div>
          <LoadingSwitch
            checked={preferences.notifyEmail}
            loading={loadingKeys.has("email")}
            onCheckedChange={(checked) =>
              handleToggle("email", { notifyEmail: checked })
            }
            ariaLabel="Toggle email notifications"
          />
        </div>

        <div
          className="flex items-center gap-4 bg-card p-4 rounded-b-xl"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          <div className="shrink-0">
            <img src={slackIcon} width={22} height={22} alt="" className="" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              Slack Notifications
            </div>
            <div className="text-sm text-muted-foreground">
              Get a Slack DM when a scheduled agent run completes or fails.
            </div>
          </div>
          <LoadingSwitch
            checked={preferences.notifySlack}
            loading={loadingKeys.has("slack")}
            onCheckedChange={(checked) =>
              handleToggle("slack", { notifySlack: checked })
            }
            ariaLabel="Toggle Slack notifications"
          />
        </div>
      </div>
    </div>
  );
}
