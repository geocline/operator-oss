"use client";

import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ComponentProps } from "react";
import { CopyButton } from "./CopyButton";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return "";
}

function MarkdownPre(
  props: ComponentProps<"pre"> & { node?: unknown },
) {
  const { node: _node, children, ...preProps } = props;
  const code = nodeText(children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <CopyButton
        text={code}
        label="Copy code"
        className="code-copy"
      />
      <pre {...preProps}>{children}</pre>
    </div>
  );
}

// Renders Claude's markdown output: headings, lists, tables, fenced code blocks
// (syntax-highlighted), inline code, links. Used for assistant + user messages.
//
// Perf: `detect: false` — only fenced blocks with an explicit language get
// highlighted; hljs auto-detection ran over every bare code block and was a
// hot spot during streaming turns. Memoized so messages whose text hasn't
// changed skip the whole markdown parse + highlight on transcript re-renders.
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          a: (props: ComponentProps<"a">) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: MarkdownPre,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
