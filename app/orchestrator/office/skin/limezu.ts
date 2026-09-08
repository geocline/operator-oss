// Declarative per-room layout for the LimeZu "Modern Interiors" skin
// (tasks/todo.md "Phase 3"). Every coordinate here is in TILE units (16px in
// the source sheets) and was picked by eye from the purchased pack extracted
// at ORCH_OFFICE_SKIN_DIR — see app/orchestrator/office/ATTRIBUTION.md. No
// tile image is ever bundled with this repo; RoomSkin.tsx loads these paths
// at runtime from GET /api/office/skin/<path>.
//
// Two kinds of source:
//  - "floor"/"wall": a single repeating tile from the Room Builder subfiles,
//    painted across the whole floor / the top wall strip.
//  - "prop": a small pre-cropped single-item sprite from Theme_Sorter_Singles
//    (already exactly one furniture piece — its whole image is the source
//    rect, so sx/sy are always 0), placed at one destination tile.
import type { RoomId } from "../types";

const ROOM_BUILDER = "1_Interiors/16x16/Room_Builder_subfiles";
const FLOORS_SHEET = `${ROOM_BUILDER}/Room_Builder_Floors_16x16.png`;
const WALLS_SHEET = `${ROOM_BUILDER}/Room_Builder_Walls_16x16.png`;

const SINGLES = "1_Interiors/16x16/Theme_Sorter_Singles";
const CONFERENCE = `${SINGLES}/13_Conference_Hall_Singles`;
const LIVING_ROOM = `${SINGLES}/2_Living_Room_Singles`;
const KITCHEN = `${SINGLES}/12_Kitchen_Singles`;
const BASEMENT = `${SINGLES}/14_Basement_Singles`;

export interface TileRef {
  /** Path relative to ORCH_OFFICE_SKIN_DIR, served via /api/office/skin/<file>. */
  file: string;
  /** Source rect, in tiles, within `file`. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface PropPlacement extends TileRef {
  /** Destination top-left, in tiles, from the room's top-left corner. */
  x: number;
  y: number;
}

export interface RoomSkinDef {
  /** Single repeating floor tile, painted across the whole room. */
  floor: TileRef;
  /** Single repeating wall tile, painted across the top strip (row 0). */
  wall: TileRef;
  /** Furniture, back-to-front. */
  props: PropPlacement[];
}

function floorTile(tx: number, ty: number): TileRef {
  return { file: FLOORS_SHEET, sx: tx, sy: ty, sw: 1, sh: 1 };
}
function wallTile(tx: number, ty: number): TileRef {
  return { file: WALLS_SHEET, sx: tx, sy: ty, sw: 1, sh: 1 };
}
function prop(file: string, w: number, h: number, x: number, y: number): PropPlacement {
  return { file, sx: 0, sy: 0, sw: w, sh: h, x, y };
}

export const LIMEZU_ROOMS: Record<RoomId, RoomSkinDef> = {
  // Grey-green lobby tile + a deep maroon accent wall.
  reception: {
    floor: floorTile(13, 2),
    wall: wallTile(22, 0),
    props: [
      prop(`${CONFERENCE}/Conference_Hall_Singles_27.png`, 2, 2, 1, 1), // reception desk
      prop(`${LIVING_ROOM}/Living_Room_Singles_14.png`, 2, 2, 4, 1), // potted palm
      prop(`${CONFERENCE}/Conference_Hall_Singles_37.png`, 1, 2, 1, 3), // office chair
      prop(`${CONFERENCE}/Conference_Hall_Singles_38.png`, 1, 2, 7, 1), // office chair
    ],
  },
  // Warm wood office floor + brown wood-panel wall, four desks with PCs.
  bullpen: {
    floor: floorTile(4, 12),
    wall: wallTile(11, 0),
    props: [
      prop(`${LIVING_ROOM}/Living_Room_Singles_19.png`, 2, 3, 1, 1),
      prop(`${CONFERENCE}/Conference_Hall_Singles_39.png`, 1, 2, 1, 4),
      prop(`${LIVING_ROOM}/Living_Room_Singles_20.png`, 2, 3, 4, 1),
      prop(`${CONFERENCE}/Conference_Hall_Singles_39.png`, 1, 2, 4, 4),
      prop(`${LIVING_ROOM}/Living_Room_Singles_21.png`, 2, 3, 7, 1),
      prop(`${CONFERENCE}/Conference_Hall_Singles_39.png`, 1, 2, 7, 4),
      prop(`${LIVING_ROOM}/Living_Room_Singles_22.png`, 2, 3, 10, 1),
      prop(`${CONFERENCE}/Conference_Hall_Singles_39.png`, 1, 2, 10, 4),
    ],
  },
  // Rose circle-tile floor + warm tan wood-plank wall, couch + coffee machine.
  breakroom: {
    floor: floorTile(8, 8),
    wall: wallTile(15, 0),
    props: [
      prop(`${LIVING_ROOM}/Living_Room_Singles_29.png`, 2, 2, 1, 1), // couch
      prop(`${KITCHEN}/Kitchen_Singles_96.png`, 1, 1, 5, 1), // coffee machine
      prop(`${LIVING_ROOM}/Living_Room_Singles_13.png`, 2, 3, 7, 1), // plant
    ],
  },
  // Plain grey concrete floor + plain grey wall, shelving + stacked boxes.
  warehouse: {
    floor: floorTile(5, 32),
    wall: wallTile(0, 4),
    props: [
      prop(`${BASEMENT}/Basement_Singles_4.png`, 1, 2, 1, 1),
      prop(`${BASEMENT}/Basement_Singles_5.png`, 1, 2, 2, 1),
      prop(`${BASEMENT}/Basement_Singles_6.png`, 1, 2, 3, 1),
      prop(`${CONFERENCE}/Conference_Hall_Singles_57.png`, 1, 1, 5, 2), // stacked boxes
      prop(`${LIVING_ROOM}/Living_Room_Singles_97.png`, 1, 1, 6, 2), // stacked crates
    ],
  },
};
