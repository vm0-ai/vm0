import type { ClipboardEvent, DragEvent } from "react";
import { useGet, useSet } from "ccstate-react";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  uploadZeroAttachment$,
  zeroDragOver$,
  setZeroDragOver$,
} from "../../signals/chat-page/chat-message.ts";

interface FileUploadHandlers {
  dragOver: boolean;
  handlePaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  handleDrop: (e: DragEvent<HTMLDivElement>) => void;
  handleDragOver: (e: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (e: DragEvent<HTMLDivElement>) => void;
}

export function useFileUploadHandlers(): FileUploadHandlers {
  const uploadAttachment = useSet(uploadZeroAttachment$);
  const dragOver = useGet(zeroDragOver$);
  const setDragOver = useSet(setZeroDragOver$);
  const { signal: rootSignal } = useGet(rootSignal$);

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          detach(uploadAttachment(file, rootSignal), Reason.DomCallback);
        }
      }
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files) {
      return;
    }
    for (const file of files) {
      detach(uploadAttachment(file, rootSignal), Reason.DomCallback);
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  };

  return { dragOver, handlePaste, handleDrop, handleDragOver, handleDragLeave };
}
