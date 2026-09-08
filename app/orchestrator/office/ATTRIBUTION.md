# Attribution

`portraitArt.ts` in this directory is a port of the procedural pixel-art
character painter from **munder-difflin** by Chaitanya Giri:

https://github.com/chaitanyagiri/munder-difflin

Original file: `src/renderer/src/scene/office/portraitArt.ts` (plus the
`cast.ts` recipe shapes it works from). The drawing primitives (head, face,
hairstyles, facial hair, glasses, clothing, scene torso/legs, outline pass)
were ported as-is; the character roster and the pixi.js texture plumbing were
not, since this app renders directly to an `HTMLCanvasElement` with no
pixi.js dependency and derives each look from a task id rather than a fixed
cast list (see `recipeFromSeed` in `portraitArt.ts`).

## Upstream license (MIT)

```
MIT License

Copyright (c) 2026 Chaitanya Giri

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Optional tile skin: Modern Interiors by LimeZu (purchased, not bundled)

`skin/limezu.ts` and `skin/RoomSkin.tsx` paint the Office view's rooms with
tiles from the **Modern Interiors** pack by LimeZu:

https://limezu.itch.io/moderninteriors

This asset pack is **purchased separately** and its license forbids
redistribution, so **no tile image from it is ever committed to this repo or
baked into a Docker image**. At runtime, if `ORCH_OFFICE_SKIN_DIR` (see
`lib/config.ts` / `.env.example`) points at a local extraction of the pack,
`GET /api/office/skin/[...path]` serves PNGs from that directory read-only and
the Office view paints the tiled floors/walls/furniture; otherwise the plain
CSS rooms render exactly as before. When the skin is active, the Office view
shows an on-screen credit linking to https://limezu.itch.io/.
