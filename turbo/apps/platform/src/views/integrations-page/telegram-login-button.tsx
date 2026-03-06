import { useSet } from "ccstate-react";
import { Button } from "@vm0/ui/components/ui/button";
import { openTelegramLoginPopup$ } from "../../signals/integrations-page/telegram-integration.ts";

interface TelegramLoginButtonProps {
  botId: string;
}

/**
 * Telegram Login button using popup mode.
 * Opens Telegram auth in a popup, which sends auth data back via postMessage.
 * The postMessage listener is managed by startTelegramLoginListener$ in the
 * page setup signal, not in this component.
 * @see https://core.telegram.org/widgets/login
 */
export function TelegramLoginButton({ botId }: TelegramLoginButtonProps) {
  const openPopup = useSet(openTelegramLoginPopup$);

  return (
    <Button size="sm" onClick={() => openPopup(botId)}>
      Connect
    </Button>
  );
}
