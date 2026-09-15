import type { ThreadMessageLike } from "@assistant-ui/react";

import type { OperatorSessionItem } from "../operator-session.js";

/**
 * Converts the framework-neutral operator transcript into assistant-ui
 * messages. Ids are scoped by session id plus index: the transcript is
 * append-only and coalescing replaces the last item in place, so index ids
 * stay stable across polls, while the session scope guarantees a session
 * switch is seen as a completely new message set (never a stale-id reuse).
 */
export function convertOperatorItem(item: OperatorSessionItem, index: number, sessionId = "single"): ThreadMessageLike {
  const id = `${sessionId}-${index}`;
  switch (item.kind) {
    case "user":
      return {
        id,
        role: "user",
        content: [{ type: "text", text: item.text }],
        ...(item.images !== undefined && item.images.length > 0
          ? {
              attachments: item.images.map((image) => ({
                id: image.id,
                type: "image" as const,
                name: "screenshot",
                contentType: image.mediaType,
                status: { type: "complete" as const },
                content: [{ type: "image" as const, image: `/api/image/${image.id}` }],
              })),
            }
          : {}),
      };
    case "assistant":
      return { id, role: "assistant", content: [{ type: "text", text: item.text }] };
    case "action":
      return { id, role: "assistant", content: [{ type: "data-action", data: { action: item.action, subjects: item.subjects } }] };
    case "outcome":
      return { id, role: "assistant", content: [{ type: "data-outcome", data: item }] };
    case "attention":
      return { id, role: "assistant", content: [{ type: "data-attention", data: { text: item.text } }] };
    case "completion":
      return { id, role: "assistant", content: [{ type: "data-completion", data: item }] };
  }
}
