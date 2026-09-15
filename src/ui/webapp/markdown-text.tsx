import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

/** Renders assistant markdown (code fences, diffs, lists, tables, links). */
export function MarkdownText() {
  return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="aui-md" />;
}
