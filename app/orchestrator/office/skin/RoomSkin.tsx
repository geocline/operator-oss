"use client";

// Canvas renderer for the LimeZu tile skin (Phase 3). Mounted behind a room's
// floor content when GET /api/office/skin reports { enabled: true }. Draws
// nothing (leaving the existing CSS room visible) on any load error, so a
// missing/misconfigured ORCH_OFFICE_SKIN_DIR degrades silently.
import { useEffect, useRef, useState } from "react";
import type { RoomId } from "../types";
import { LIMEZU_ROOMS, type TileRef } from "./limezu";

const SRC_TILE = 16; // px per tile in the source sheets

/** Shared HTMLImageElement cache, keyed by the /api/office/skin/<file> URL —
 * every room reuses the same sheets, so load each one exactly once. */
const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(file: string): Promise<HTMLImageElement> {
  const url = `/api/office/skin/${file}`;
  let p = imageCache.get(url);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`office skin: failed to load ${url}`));
    img.src = url;
  });
  imageCache.set(url, p);
  return p;
}

function pickScale(widthPx: number): number {
  // Integer scale so pixel art stays crisp; wider rooms get the bigger scale.
  return widthPx >= 520 ? 3 : 2;
}

export function RoomSkin({ room }: { room: RoomId }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!size || size.w <= 0 || size.h <= 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const def = LIMEZU_ROOMS[room];
    const scale = pickScale(size.w);
    const tile = SRC_TILE * scale;
    canvas.width = size.w;
    canvas.height = size.h;

    let cancelled = false;
    const files = new Set<string>([def.floor.file, def.wall.file, ...def.props.map((p) => p.file)]);

    Promise.all(Array.from(files, (f) => loadImage(f).then((img) => [f, img] as const)))
      .then((loaded) => {
        if (cancelled) return;
        const images = new Map(loaded);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const draw = (ref: TileRef, dx: number, dy: number) => {
          const img = images.get(ref.file);
          if (!img) return;
          ctx.drawImage(
            img,
            ref.sx * SRC_TILE, ref.sy * SRC_TILE, ref.sw * SRC_TILE, ref.sh * SRC_TILE,
            dx, dy, ref.sw * tile, ref.sh * tile,
          );
        };

        // Floor: tile the whole area.
        const cols = Math.ceil(canvas.width / tile) + 1;
        const rows = Math.ceil(canvas.height / tile) + 1;
        for (let ty = 0; ty < rows; ty++) {
          for (let tx = 0; tx < cols; tx++) draw(def.floor, tx * tile, ty * tile);
        }
        // Wall: one strip along the top.
        for (let tx = 0; tx < cols; tx++) draw(def.wall, tx * tile, 0);
        // Props, back-to-front, clipped to whatever fits in the canvas.
        for (const p of def.props) draw(p, p.x * tile, p.y * tile);
      })
      .catch(() => {
        if (!cancelled) ctx.clearRect(0, 0, canvas.width, canvas.height);
      });

    return () => { cancelled = true; };
  }, [room, size]);

  return (
    <canvas
      ref={canvasRef}
      className="ofc-room-skin-canvas"
      aria-hidden="true"
    />
  );
}
