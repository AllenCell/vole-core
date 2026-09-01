import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import { computeTripleLayout, computeTripleViewPanes } from "../utils/tripleSliceLayout.js";

const GAP = 2;

describe("computeTripleLayout", () => {
  it("fits a cube uniformly, choosing the smaller of the two axis scales", () => {
    const layout = computeTripleLayout(new Vector3(1, 1, 1), 100, 100, GAP);
    expect(layout).not.toBeNull();
    // scaleX = (100 - 2) / (px + pz) = 98 / 2 = 49; scaleY identical -> fitScale 49
    expect(layout!.fitScale).toBeCloseTo(49);
    expect(layout!.px).toBe(1);
    expect(layout!.py).toBe(1);
    expect(layout!.pz).toBe(1);
  });

  it("picks the limiting axis when width and height differ", () => {
    // Wide-but-short canvas: height is the constraint.
    const layout = computeTripleLayout(new Vector3(1, 1, 1), 400, 100, GAP);
    // scaleX = 398 / 2 = 199; scaleY = 98 / 2 = 49 -> min is 49
    expect(layout!.fitScale).toBeCloseTo(49);
  });

  it("returns null for a degenerate area (available <= gap)", () => {
    expect(computeTripleLayout(new Vector3(1, 1, 1), GAP, GAP, GAP)).toBeNull();
    expect(computeTripleLayout(new Vector3(1, 1, 1), 0, 0, GAP)).toBeNull();
  });
});

describe("computeTripleViewPanes", () => {
  it("lays out a cube into three equal, non-overlapping panes centered in the canvas", () => {
    const panes = computeTripleViewPanes(new Vector3(1, 1, 1), 100, 100, GAP);

    // fitScale 49 -> every pane edge is floor(1 * 49) = 49
    expect(panes.xy).toEqual({ x: 0, y: 0, w: 49, h: 49 });
    expect(panes.yz).toEqual({ x: 51, y: 0, w: 49, h: 49 });
    expect(panes.xz).toEqual({ x: 0, y: 51, w: 49, h: 49 });
  });

  it("places YZ to the right of XY and XZ above XY, separated by the gap", () => {
    const panes = computeTripleViewPanes(new Vector3(1, 1, 1), 100, 100, GAP);
    // bottom-left origin: YZ shares XY's bottom edge, XZ shares XY's left edge
    expect(panes.yz.x).toBe(panes.xy.x + panes.xy.w + GAP);
    expect(panes.yz.y).toBe(panes.xy.y);
    expect(panes.xz.y).toBe(panes.xy.y + panes.xy.h + GAP);
    expect(panes.xz.x).toBe(panes.xy.x);
  });

  it("maps physical axes to the correct pane edges for an anisotropic volume", () => {
    // X twice as wide physically as Y and Z.
    const panes = computeTripleViewPanes(new Vector3(2, 1, 1), 100, 100, GAP);

    // XY spans (X, Y); YZ spans (Z, Y); XZ spans (X, Z).
    expect(panes.xz.w).toBe(panes.xy.w); // both span X
    expect(panes.yz.h).toBe(panes.xy.h); // both span Y
    expect(panes.xz.h).toBe(panes.yz.w); // both span Z
    // X is the wider physical axis, so the X-spanning edge exceeds the Z-spanning edge.
    expect(panes.xy.w).toBeGreaterThan(panes.yz.w);
  });

  it("keeps all panes within the canvas bounds", () => {
    const canvasW = 137;
    const canvasH = 211;
    const panes = computeTripleViewPanes(new Vector3(1.3, 0.7, 2.1), canvasW, canvasH, GAP);

    for (const rect of [panes.xy, panes.yz, panes.xz]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(canvasW);
      expect(rect.y + rect.h).toBeLessThanOrEqual(canvasH);
    }
  });

  it("returns zero-size panes for a degenerate canvas", () => {
    const panes = computeTripleViewPanes(new Vector3(1, 1, 1), GAP, GAP, GAP);
    expect(panes.xy).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(panes.yz).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(panes.xz).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("returns distinct rect objects so callers can mutate one without affecting others", () => {
    const panes = computeTripleViewPanes(new Vector3(1, 1, 1), GAP, GAP, GAP);
    expect(panes.xy).not.toBe(panes.yz);
    expect(panes.yz).not.toBe(panes.xz);
  });
});
