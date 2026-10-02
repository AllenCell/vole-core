import type { Vector3 } from "three";

import type { TripleViewPanes } from "../types.js";

/**
 * Computes the uniform fit-scale and pane dimensions (in volume-normalized units,
 * where 1.0 is the longest physical dimension of the volume) for triple-slice layout.
 * Pure function of the volume's physical size and the available area.
 * @param normPhysicalSize Normalized physical size of the volume.
 * @param availableW Available width (CSS pixels or world units).
 * @param availableH Available height, in the same units as `availableW`.
 * @param gap Gap between panes, in the same units as `availableW`/`availableH`.
 * @returns The uniform scale (units per physical unit) and normalized physical
 *   dimensions, or null if the available dimensions are insufficient.
 */
export function computeTripleLayout(
  normPhysicalSize: Vector3,
  availableW: number,
  availableH: number,
  gap: number
): { fitScale: number; px: number; py: number; pz: number } | null {
  const px = normPhysicalSize.x;
  const py = normPhysicalSize.y;
  const pz = normPhysicalSize.z;

  const scaleX = (availableW - gap) / (px + pz);
  const scaleY = (availableH - gap) / (py + pz);
  const fitScale = Math.min(scaleX, scaleY);
  if (fitScale <= 0) {
    return null;
  }
  return { fitScale, px, py, pz };
}

/**
 * Computes the per-pane rectangles for triple-slice view in CSS pixels (bottom-left origin).
 * Pure function of the volume's physical size and the canvas dimensions.
 *
 * Layout (bottom-left origin):
 * ```
 *  +--------+--------+
 *  |   XZ   |        |
 *  +--------+--------+
 *  |   XY   |   YZ   |
 *  +--------+--------+
 * ```
 * @param normPhysicalSize Normalized physical size of the volume.
 * @param canvasW Canvas width in CSS pixels.
 * @param canvasH Canvas height in CSS pixels.
 * @param gap Gap between panes in CSS pixels.
 * @returns The three pane rects, centered in the canvas; all zero-size if the layout is degenerate.
 */
export function computeTripleViewPanes(
  normPhysicalSize: Vector3,
  canvasW: number,
  canvasH: number,
  gap: number
): TripleViewPanes {
  const layout = computeTripleLayout(normPhysicalSize, canvasW, canvasH, gap);
  if (!layout) {
    // Degenerate: return zero-size panes
    return { xy: { x: 0, y: 0, w: 0, h: 0 }, yz: { x: 0, y: 0, w: 0, h: 0 }, xz: { x: 0, y: 0, w: 0, h: 0 } };
  }
  const { fitScale, px, py, pz } = layout;

  const xyW = Math.floor(px * fitScale);
  const xyH = Math.floor(py * fitScale);
  const yzW = Math.floor(pz * fitScale);
  const yzH = Math.floor(py * fitScale);
  const xzW = Math.floor(px * fitScale);
  const xzH = Math.floor(pz * fitScale);

  const totalW = xyW + gap + yzW;
  const totalH = xyH + gap + xzH;
  const offsetX = Math.floor((canvasW - totalW) / 2);
  const offsetY = Math.floor((canvasH - totalH) / 2);

  return {
    xy: { x: offsetX, y: offsetY, w: xyW, h: xyH },
    yz: { x: offsetX + xyW + gap, y: offsetY, w: yzW, h: yzH },
    xz: { x: offsetX, y: offsetY + xyH + gap, w: xzW, h: xzH },
  };
}
