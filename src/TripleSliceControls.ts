import type { Vector3 } from "three";

import type { TripleSliceSource } from "./VolumeRenderImpl.js";
import { Axis } from "./types.js";
import type { TripleViewPanes } from "./types.js";

/** Minimal interface for the host panel that TripleSliceControls needs. */
export interface TripleSliceHost {
  containerdiv: HTMLDivElement;
  getTripleViewPanesCSS(): TripleViewPanes | undefined;
  redraw(): void;
}

/**
 * Handles pointer interaction (drag and double-click) for triple-slice crosshair mode.
 * Manages event listener attachment/detachment and translates pointer positions
 * into slice index updates via the {@link TripleSliceSource}.
 */
export default class TripleSliceControls {
  private host: TripleSliceHost;

  source?: TripleSliceSource;
  changeCallback?: (indices: Vector3) => void;

  private dragging = false;
  private dragPane?: "xy" | "yz" | "xz";
  private dragAxis?: "u" | "v";
  private boundPointerDown?: (e: PointerEvent) => void;
  private boundPointerMove?: (e: PointerEvent) => void;
  private boundPointerUp?: (e: PointerEvent) => void;
  private boundDblClick?: (e: MouseEvent) => void;

  private static readonly CROSSHAIR_GRAB_THRESHOLD = 8;

  constructor(host: TripleSliceHost) {
    this.host = host;
  }

  /** Attach pointer event listeners to the host container. Call when entering triple-slice mode. */
  attach(): void {
    if (!this.source) {
      return;
    }

    this.boundPointerDown = this.onPointerDown.bind(this);
    this.boundPointerMove = this.onPointerMove.bind(this);
    this.boundPointerUp = this.onPointerUp.bind(this);
    this.boundDblClick = this.onDblClick.bind(this);
    this.host.containerdiv.addEventListener("pointerdown", this.boundPointerDown);
    this.host.containerdiv.addEventListener("pointermove", this.boundPointerMove);
    this.host.containerdiv.addEventListener("pointerup", this.boundPointerUp);
    this.host.containerdiv.addEventListener("dblclick", this.boundDblClick);
  }

  /** Remove pointer event listeners from the host container. Call when leaving triple-slice mode. */
  detach(): void {
    if (this.boundPointerDown) {
      this.host.containerdiv.removeEventListener("pointerdown", this.boundPointerDown);
    }
    if (this.boundPointerMove) {
      this.host.containerdiv.removeEventListener("pointermove", this.boundPointerMove);
    }
    if (this.boundPointerUp) {
      this.host.containerdiv.removeEventListener("pointerup", this.boundPointerUp);
    }
    if (this.boundDblClick) {
      this.host.containerdiv.removeEventListener("dblclick", this.boundDblClick);
    }
    this.boundPointerDown = undefined;
    this.boundPointerMove = undefined;
    this.boundPointerUp = undefined;
    this.boundDblClick = undefined;
    this.dragging = false;
    this.dragAxis = undefined;
  }

  // --- Hit testing ---

  private hitTestPane(clientX: number, clientY: number): "xy" | "yz" | "xz" | null {
    const panes = this.host.getTripleViewPanesCSS();
    if (!panes) {
      return null;
    }
    const rect = this.host.containerdiv.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    for (const [key, pane] of Object.entries(panes) as [
      "xy" | "yz" | "xz",
      { x: number; y: number; w: number; h: number },
    ][]) {
      if (x >= pane.x && x <= pane.x + pane.w && y >= pane.y && y <= pane.y + pane.h) {
        return key;
      }
    }
    return null;
  }

  private pointerToPaneUV(
    clientX: number,
    clientY: number,
    paneKey: "xy" | "yz" | "xz"
  ): { u: number; v: number } | null {
    const panes = this.host.getTripleViewPanesCSS();
    if (!panes) {
      return null;
    }
    const rect = this.host.containerdiv.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const pane = panes[paneKey];

    const u = Math.max(0, Math.min(1, (x - pane.x) / pane.w));
    // v is inverted: top of CSS = 0, but top of UV should be 1
    const v = Math.max(0, Math.min(1, 1 - (y - pane.y) / pane.h));
    return { u, v };
  }

  private hitTestCrosshairLine(clientX: number, clientY: number, paneKey: "xy" | "yz" | "xz"): "u" | "v" | null {
    if (!this.source) {
      return null;
    }
    const panes = this.host.getTripleViewPanesCSS();
    if (!panes) {
      return null;
    }
    const containerRect = this.host.containerdiv.getBoundingClientRect();
    const mx = clientX - containerRect.left;
    const my = clientY - containerRect.top;
    const pane = panes[paneKey];

    const indices = this.source.getIndices();
    const volSize = this.source.getVolumeSize();

    // Compute normalized crosshair positions for this pane
    let uNorm: number; // normalized position of the vertical line
    let vNorm: number; // normalized position of the horizontal line
    switch (paneKey) {
      case "xy":
        uNorm = volSize.x > 1 ? indices.x / (volSize.x - 1) : 0.5;
        vNorm = volSize.y > 1 ? indices.y / (volSize.y - 1) : 0.5;
        break;
      case "yz":
        uNorm = volSize.z > 1 ? indices.z / (volSize.z - 1) : 0.5;
        vNorm = volSize.y > 1 ? indices.y / (volSize.y - 1) : 0.5;
        break;
      case "xz":
        uNorm = volSize.x > 1 ? indices.x / (volSize.x - 1) : 0.5;
        vNorm = volSize.z > 1 ? indices.z / (volSize.z - 1) : 0.5;
        break;
    }

    // Convert to CSS pixel positions within the pane
    const verticalLineX = pane.x + uNorm * pane.w;
    const horizontalLineY = pane.y + (1 - vNorm) * pane.h;

    const threshold = TripleSliceControls.CROSSHAIR_GRAB_THRESHOLD;
    const distToVertical = Math.abs(mx - verticalLineX);
    const distToHorizontal = Math.abs(my - horizontalLineY);

    // If both are within threshold, pick the closer one
    if (distToVertical <= threshold && distToHorizontal <= threshold) {
      return distToVertical <= distToHorizontal ? "v" : "u";
    }
    if (distToVertical <= threshold) {
      return "v";
    }
    if (distToHorizontal <= threshold) {
      return "u";
    }
    return null;
  }

  // --- Event handlers ---

  private onPointerDown(e: PointerEvent): void {
    const pane = this.hitTestPane(e.clientX, e.clientY);
    if (!pane) {
      return;
    }
    const selectedAxis = this.hitTestCrosshairLine(e.clientX, e.clientY, pane);
    if (selectedAxis) {
      this.dragging = true;
      this.dragPane = pane;
      this.dragAxis = selectedAxis;
      this.handleDrag(e.clientX, e.clientY, pane, selectedAxis);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.dragging && this.dragPane && this.dragAxis) {
      this.handleDrag(e.clientX, e.clientY, this.dragPane, this.dragAxis);
    }
  }

  private onPointerUp(_e: PointerEvent): void {
    this.dragging = false;
    this.dragPane = undefined;
    this.dragAxis = undefined;
  }

  private onDblClick(e: MouseEvent): void {
    const pane = this.hitTestPane(e.clientX, e.clientY);
    if (!pane || !this.source) {
      return;
    }
    const uv = this.pointerToPaneUV(e.clientX, e.clientY, pane);
    if (!uv) {
      return;
    }

    const volSize = this.source.getVolumeSize();

    // Move both crosshairs to the double-click point
    switch (pane) {
      case "xy":
        this.source.setSliceIndex(Axis.X, Math.round(uv.u * (volSize.x - 1)));
        this.source.setSliceIndex(Axis.Y, Math.round(uv.v * (volSize.y - 1)));
        break;
      case "yz":
        this.source.setSliceIndex(Axis.Z, Math.round(uv.u * (volSize.z - 1)));
        this.source.setSliceIndex(Axis.Y, Math.round(uv.v * (volSize.y - 1)));
        break;
      case "xz":
        this.source.setSliceIndex(Axis.X, Math.round(uv.u * (volSize.x - 1)));
        this.source.setSliceIndex(Axis.Z, Math.round(uv.v * (volSize.z - 1)));
        break;
    }

    this.changeCallback?.(this.source.getIndices());
    this.host.redraw();
  }

  private handleDrag(clientX: number, clientY: number, paneKey: "xy" | "yz" | "xz", axis: "u" | "v"): void {
    if (!this.source) {
      return;
    }
    const uv = this.pointerToPaneUV(clientX, clientY, paneKey);
    if (!uv) {
      return;
    }

    const volSize = this.source.getVolumeSize();

    // The vertical or horizontal axis depends on which projection pane we are in.
    // axis "v" → dragging the vertical line → updates the u-coordinate
    // axis "u" → dragging the horizontal line → updates the v-coordinate
    switch (paneKey) {
      case "xy":
        if (axis === "v") {
          this.source.setSliceIndex(Axis.X, Math.round(uv.u * (volSize.x - 1)));
        } else {
          this.source.setSliceIndex(Axis.Y, Math.round(uv.v * (volSize.y - 1)));
        }
        break;
      case "yz":
        if (axis === "v") {
          this.source.setSliceIndex(Axis.Z, Math.round(uv.u * (volSize.z - 1)));
        } else {
          this.source.setSliceIndex(Axis.Y, Math.round(uv.v * (volSize.y - 1)));
        }
        break;
      case "xz":
        if (axis === "v") {
          this.source.setSliceIndex(Axis.X, Math.round(uv.u * (volSize.x - 1)));
        } else {
          this.source.setSliceIndex(Axis.Z, Math.round(uv.v * (volSize.z - 1)));
        }
        break;
    }

    this.changeCallback?.(this.source.getIndices());
    this.host.redraw();
  }
}
