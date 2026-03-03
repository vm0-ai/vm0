import { useLastResolved, useSet } from "ccstate-react";
import { Switch } from "@vm0/ui/components/ui/switch";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import {
  notificationPreferences$,
  updateNotificationPreference$,
} from "../../signals/settings-page/notification-settings.ts";
import { detach, Reason } from "../../signals/utils.ts";
import emailIcon from "./icons/email.svg";
import slackIcon from "./icons/slack.svg";

export function NotificationSettings() {
  const preferences = useLastResolved(notificationPreferences$);
  const updatePreference = useSet(updateNotificationPreference$);

  if (!preferences) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-5 w-32 rounded" />
          <Skeleton className="h-4 w-80 rounded" />
        </div>
        <div className="flex flex-col">
          <Skeleton className="h-[76px] w-full rounded-t-xl rounded-b-none" />
          <Skeleton className="h-[76px] w-full rounded-t-none rounded-b-xl border-t border-background" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">Notifications</h3>
        <p className="text-sm text-muted-foreground">
          Manage how you receive notifications about agent runs, errors, and
          updates.
        </p>
      </div>

      <div className="flex flex-col">
        <div className="flex items-center gap-4 border-l border-r border-t border-border bg-card p-4 rounded-t-xl">
          <div className="shrink-0">
            <img
              src={emailIcon}
              width={28}
              height={28}
              alt=""
              className="text-foreground"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              Email Notifications
            </div>
            <div className="text-sm text-muted-foreground">
              Receive email notifications for agent run completions, errors, and
              important updates.
            </div>
          </div>
          <div className="shrink-0">
            <Switch
              checked={preferences.notifyEmail}
              onCheckedChange={(checked) =>
                detach(
                  updatePreference({ notifyEmail: checked }),
                  Reason.DomCallback,
                )
              }
              aria-label="Toggle email notifications"
            />
          </div>
        </div>

        <div className="flex items-center gap-4 border border-border bg-card p-4 rounded-b-xl">
          <div className="shrink-0">
            <img src={slackIcon} width={28} height={28} alt="" />
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              Slack Notifications
            </div>
            <div className="text-sm text-muted-foreground">
              Send notifications to your Slack workspace when agents complete
              runs or encounter errors.
            </div>
          </div>
          <div className="shrink-0">
            <Switch
              checked={preferences.notifySlack}
              onCheckedChange={(checked) =>
                detach(
                  updatePreference({ notifySlack: checked }),
                  Reason.DomCallback,
                )
              }
              aria-label="Toggle Slack notifications"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
