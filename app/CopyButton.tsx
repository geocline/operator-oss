"use client";

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 1600);
    } catch {
      setStatus("error");
      window.setTimeout(() => setStatus("idle"), 2400);
    }
  };

  return (
    <button
      type="button"
      className={`copy-btn ${className}`.trim()}
      onClick={copy}
      aria-label={label}
      title={label}
    >
      {status === "copied" ? "Copied" : status === "error" ? "Select to copy" : label}
      <span className="sr-only" aria-live="polite">
        {status === "copied"
          ? "Copied to clipboard"
          : status === "error"
            ? "Clipboard unavailable; select the text to copy"
            : ""}
      </span>
    </button>
  );
}

