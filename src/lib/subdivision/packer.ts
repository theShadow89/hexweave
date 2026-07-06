import { MaxRectsPacker } from "maxrects-packer";
import type { PackedBed, PlateSpec } from "@/types";

export interface PackInput {
  id: string;
  width: number;
  height: number;
}

/**
 * Pack the given rectangular items onto one or more print beds using maxrects.
 * `margin` is kept clear inside the bed on every side; items can be rotated
 * 90° if that yields a better fit.
 */
export function packBeds(
  items: PackInput[],
  plate: PlateSpec,
  margin: number,
  padding = 2,
): PackedBed[] {
  const usableW = Math.max(0, plate.width - 2 * margin);
  const usableH = Math.max(0, plate.height - 2 * margin);
  if (items.length === 0 || usableW <= 0 || usableH <= 0) return [];

  const packer = new MaxRectsPacker(usableW, usableH, padding, {
    smart: true,
    pot: false,
    square: false,
    allowRotation: true,
  });
  for (const item of items) {
    packer.add(item.width, item.height, { id: item.id });
  }

  return packer.bins.map((bin, index) => ({
    index,
    plate,
    margin,
    items: bin.rects.map((rect) => ({
      id: (rect.data as { id: string }).id,
      width: rect.width,
      height: rect.height,
      x: rect.x + margin,
      y: rect.y + margin,
      rotated: rect.rot,
    })),
  }));
}
