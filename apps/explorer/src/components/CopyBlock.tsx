"use client";
import { useState } from "react";

/** Preformatted block with a copy button (client configs, SQL). */
export function CopyBlock({
  text,
  label,
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => setCopied(false));
  };
  return (
    <div className={`relative ${className}`}>
      {label ? <div className="mb-1 text-xs font-medium text-zinc-500">{label}</div> : null}
      <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed dark:border-zinc-800 dark:bg-zinc-900">
        <code>{text}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        className="btn absolute top-1 right-1 px-2 py-0.5 text-xs"
        style={label ? { top: "1.5rem" } : undefined}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
