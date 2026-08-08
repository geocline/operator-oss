"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CopyButton } from "../CopyButton";

interface ArtifactItem {
  id: string;
  project_id: string;
  task_id: string;
  title: string;
  filename: string;
  content_type: string;
  byte_size: number;
  created_at: number;
  project_name: string;
  project_color: string;
  task_title: string;
  url: string;
  download_url: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatType(type: string, filename: string): string {
  if (type.startsWith("text/html")) return "HTML";
  if (type === "application/pdf") return "PDF";
  if (type.startsWith("image/")) return type.slice(6).toUpperCase();
  const extension = filename.split(".").pop();
  return extension ? extension.toUpperCase() : "FILE";
}

export function ArtifactLibrary() {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/artifacts?q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Could not load artifacts.");
        const data = (await response.json()) as { artifacts: ArtifactItem[] };
        setItems(data.artifacts);
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Could not load artifacts.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 180 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, reload]);

  const heading = useMemo(
    () => (query.trim() ? `Results for “${query.trim()}”` : "Most recent"),
    [query],
  );

  return (
    <main className="artifact-shell">
      <header className="artifact-topbar">
        <Link href="/" className="artifact-brand">Operator</Link>
        <span className="artifact-divider">/</span>
        <strong>Artifacts</strong>
        <span className="artifact-spacer" />
        <Link href="/" className="artifact-back">Back to workspace</Link>
      </header>

      <section className="artifact-hero">
        <div>
          <p className="artifact-eyebrow">Private library</p>
          <h1>Artifacts</h1>
          <p>Finished files published from every Operator project, newest first.</p>
        </div>
        <label className="artifact-search">
          <span>Search artifacts</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, project, or task"
          />
        </label>
      </section>

      <section className="artifact-feed">
        <div className="artifact-feed-head">
          <h2>{heading}</h2>
          {!loading && <span>{items.length} item{items.length === 1 ? "" : "s"}</span>}
        </div>

        {error && (
          <div className="artifact-state error">
            <p>{error}</p>
            <button type="button" onClick={() => setReload((value) => value + 1)}>Retry</button>
          </div>
        )}
        {loading && <div className="artifact-state">Loading artifacts…</div>}
        {!loading && !error && items.length === 0 && (
          <div className="artifact-state">
            {query ? "No artifacts match that search." : "No artifacts have been published yet. Ask an agent to “Publish that artifact.”"}
          </div>
        )}

        {!loading && !error && (
          <div className="artifact-grid">
            {items.map((artifact) => {
              const stableUrl =
                typeof window === "undefined"
                  ? artifact.url
                  : new URL(artifact.url, window.location.origin).toString();
              return (
                <article className="artifact-card" key={artifact.id}>
                  <div className="artifact-card-top">
                    <span className="artifact-type">{formatType(artifact.content_type, artifact.filename)}</span>
                    <time dateTime={new Date(artifact.created_at).toISOString()}>
                      {new Date(artifact.created_at).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <Link href={`/artifacts/${artifact.id}`} className="artifact-title">
                    {artifact.title}
                  </Link>
                  <div className="artifact-filename">{artifact.filename} · {formatBytes(artifact.byte_size)}</div>
                  <div className="artifact-tags">
                    <Link href={`/?project=${artifact.project_id}`} className="artifact-tag">
                      <i style={{ background: artifact.project_color }} />
                      {artifact.project_name}
                    </Link>
                    <Link
                      href={`/?project=${artifact.project_id}&task=${artifact.task_id}`}
                      className="artifact-tag task"
                    >
                      {artifact.task_title}
                    </Link>
                  </div>
                  <div className="artifact-actions">
                    <Link href={`/artifacts/${artifact.id}`} className="artifact-primary">Open</Link>
                    <CopyButton text={stableUrl} label="Copy link" />
                    <a href={artifact.download_url}>Download</a>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

