import { readFileSync } from "node:fs";
import type { Attachment, SourceBundle } from "./model/source.js";
import type { ContentPart } from "./provider/openrouter.js";

/** Turn an attachment into the native content part the vision model expects. */
export function toContentPart(att: Attachment): ContentPart {
  if (att.kind === "image") {
    if (att.url) return { type: "image_url", image_url: { url: att.url } };
    if (att.path) {
      const data = readFileSync(att.path).toString("base64");
      return { type: "image_url", image_url: { url: `data:${att.mime};base64,${data}` } };
    }
    throw new Error(`Attachment ${att.id} has neither url nor path`);
  }
  // pdf
  if (att.url) {
    return { type: "file", file: { filename: att.id, file_data: att.url } };
  }
  if (att.path) {
    const data = readFileSync(att.path).toString("base64");
    return { type: "file", file: { filename: att.path.split("/").pop() ?? att.id, file_data: data } };
  }
  throw new Error(`Attachment ${att.id} has neither url nor path`);
}

/**
 * Render the source as message content parts. Text sources become a text part.
 * Binary sources become native parts, so layout survives to the model.
 */
export function sourceToContent(source: SourceBundle): ContentPart[] {
  const parts: ContentPart[] = [];
  if (source.text.trim()) {
    const header = [`# ${source.title}`];
    if (source.uri) header.push(`Source: ${source.uri}`);
    if (source.duration) header.push(`Duration: ${Math.round(source.duration)}s`);
    parts.push({ type: "text", text: `${header.join("\n")}\n\n---\n\n${source.text}` });
  } else {
    parts.push({ type: "text", text: `# ${source.title}\n\nAttached document follows.` });
  }
  for (const att of source.attachments) parts.push(toContentPart(att));
  return parts;
}
