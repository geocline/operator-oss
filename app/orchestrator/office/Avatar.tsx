"use client";

import { useEffect, useRef } from "react";
import { paintSceneFrame, SCENE_W, SCENE_H, type Recipe } from "./portraitArt";

// 6fps walk cycle for the Bullpen; everyone else gets a CSS idle bob instead
// (no canvas repaint cost for avatars that aren't "working").
const WALK_FRAME_MS = 1000 / 6;
const SCALE = 3;

/** Project-initials badge, colored by a hash of the project id so the same
 * project always gets the same color without a lookup table. */
export function ProjectBadge({ id, name }: { id: string; name: string }) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";
  return (
    <span
      className="ofc-badge"
      style={{ background: `hsl(${hue} 55% 22%)`, color: `hsl(${hue} 85% 78%)` }}
      title={name}
    >
      {initials}
    </span>
  );
}

/** A single task's pixel-art avatar: a canvas painted from its recipe, walking
 * in the Bullpen (rAF frame swap) or idling (pure CSS bob) elsewhere. Pauses
 * all animation while the tab is hidden. */
export function Avatar({ recipe, walking, size }: { recipe: Recipe; walking: boolean; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const w = SCENE_W * SCALE, h = SCENE_H * SCALE;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Always paint the standing frame synchronously so the avatar is visible
    // on first render; the walk loop below only advances frames from there.
    // (Without this a hidden/backgrounded tab showed an empty canvas until
    // the first rAF tick fired.)
    paintSceneFrame(ctx, recipe, 0, SCALE);
    if (!walking) return;

    let frame = 0;
    let raf = 0;
    let last = 0;
    let stopped = false;
    const tick = (t: number) => {
      if (stopped) return;
      if (!document.hidden && t - last >= WALK_FRAME_MS) {
        last = t;
        frame = (frame + 1) % 3;
        paintSceneFrame(ctx, recipe, frame, SCALE);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(raf); };
    // recipeKey changes are covered by JSON identity in portraitArt's cache;
    // re-running the effect on recipe reference change is enough here.
  }, [recipe, walking]);

  const style = size ? { width: size, height: size * (h / w) } : undefined;
  return (
    <canvas
      ref={canvasRef}
      width={w}
      height={h}
      className={`ofc-avatar-canvas${walking ? "" : " ofc-idle-bob"}`}
      style={style}
    />
  );
}
