import type { ChatEvent } from "@vm0/api-contracts/contracts/chat-threads";

type ChatEventAnnotation = NonNullable<ChatEvent["annotation"]>;

type ChatEventAnnotationContext =
  | {
      readonly kind: "slack";
      readonly messagePermalink: string | null;
    }
  | {
      readonly kind: "feishu";
      readonly chatOpenUrl: string | null;
    }
  | {
      readonly kind: "teams";
      readonly tenantId: string | null;
      readonly channelId: string | null;
      readonly activityId: string | null;
    }
  | {
      readonly kind: "telegram";
      readonly chatId: string | null;
      readonly messageId: string | null;
      readonly isDm: boolean | null;
    }
  | {
      readonly kind: "github";
      readonly repo: string | null;
      readonly subjectNumber: number | null;
      readonly subjectKind: "issue" | "pull_request" | null;
      readonly triggerCommentId: string | null;
    };

function storedHref(value: string | null): string | undefined {
  return value ?? undefined;
}

function teamsMessageUrl(
  context: Extract<ChatEventAnnotationContext, { readonly kind: "teams" }>,
): string | undefined {
  if (!context.channelId || !context.activityId || !context.tenantId) {
    return undefined;
  }
  return (
    `https://teams.microsoft.com/l/message/${encodeURIComponent(
      context.channelId,
    )}/${encodeURIComponent(context.activityId)}` +
    `?tenantId=${encodeURIComponent(context.tenantId)}`
  );
}

function telegramMessageUrl(
  context: Extract<ChatEventAnnotationContext, { readonly kind: "telegram" }>,
): string | undefined {
  if (
    context.isDm !== false ||
    context.chatId === null ||
    context.messageId === null ||
    !context.chatId.startsWith("-100")
  ) {
    return undefined;
  }
  const internalChatId = context.chatId.slice(4);
  if (
    !/^[1-9]\d*$/u.test(internalChatId) ||
    !/^[1-9]\d*$/u.test(context.messageId)
  ) {
    return undefined;
  }
  return `https://t.me/c/${internalChatId}/${context.messageId}`;
}

function githubSubjectUrl(
  context: Extract<ChatEventAnnotationContext, { readonly kind: "github" }>,
): string | undefined {
  if (
    context.repo === null ||
    context.subjectNumber === null ||
    context.subjectKind === null
  ) {
    return undefined;
  }
  const [owner, repo, ...extraParts] = context.repo.split("/");
  if (
    !owner ||
    !repo ||
    extraParts.length > 0 ||
    !Number.isInteger(context.subjectNumber) ||
    context.subjectNumber <= 0
  ) {
    return undefined;
  }
  const commentId = context.triggerCommentId;
  if (commentId !== null && !/^[1-9]\d*$/u.test(commentId)) {
    return undefined;
  }
  const subjectPath =
    context.subjectKind === "pull_request" ? "pull" : "issues";
  const subjectUrl = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/${subjectPath}/${context.subjectNumber}`;
  return commentId === null
    ? subjectUrl
    : `${subjectUrl}#issuecomment-${commentId}`;
}

export function projectChatEventAnnotation(
  context: ChatEventAnnotationContext,
): ChatEventAnnotation {
  let href: string | undefined;
  if (context.kind === "slack") {
    href = storedHref(context.messagePermalink);
  } else if (context.kind === "feishu") {
    href = storedHref(context.chatOpenUrl);
  } else if (context.kind === "teams") {
    href = teamsMessageUrl(context);
  } else if (context.kind === "telegram") {
    href = telegramMessageUrl(context);
  } else {
    href = githubSubjectUrl(context);
  }
  return {
    kind: context.kind,
    ...(href ? { href } : {}),
  };
}
