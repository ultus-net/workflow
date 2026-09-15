import { type ReactNode } from "react";
import hljs from "highlight.js/lib/common";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Fenced code renderer: syntax highlighting (highlight.js common languages)
 * plus a per-block copy button. Inline code renders untouched. The highlight
 * output is escaped HTML produced by hljs itself, so injecting it is safe by
 * construction; unknown languages fall back to plaintext.
 */
function CodePart({ className, children }: { className?: string | undefined; children?: ReactNode }) {
  const text = String(children ?? "").replace(/\n$/, "");
  const language = /language-([\w+-]+)/.exec(className ?? "")?.[1];
  // Inline code (no language, single line) renders untouched; fenced blocks
  // without a language still keep block chrome — multi-line is the signal.
  const isBlock = language !== undefined || text.includes("\n");
  if (!isBlock) return <code className={className}>{children}</code>;
  const shown = language ?? "plaintext";
  const known = language !== undefined && hljs.getLanguage(language) !== undefined;
  const highlighted = hljs.highlight(text, { language: known ? language! : "plaintext" }).value;
  return (
    <span className="code-block">
      <span className="code-block-head">
        <span className="code-block-lang">{known ? language : ""}</span>
        <CopyButton text={text} label="Copy" />
      </span>
      <pre className="code-block-pre"><code className={`hljs language-${shown}`} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
    </span>
  );
}

/** Clipboard button for code blocks; failures (permissions, focus) stay quiet. */
function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  return (
    <button
      type="button"
      className="copy-button"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => undefined);
      }}
    >
      {label}
    </button>
  );
}

/** Renders assistant markdown (code fences, diffs, lists, tables, links). */
export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md"
      components={{
        // Block code is unwrapped from react-markdown's default <pre> so the
        // renderer owns the whole block chrome (header, copy, highlighting).
        pre: ({ children }) => <>{children}</>,
        code: CodePart,
      }}
    />
  );
}
