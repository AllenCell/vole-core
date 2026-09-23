import { Box3, Vector3 } from "three";

import { LoadSpec } from "../loaders/VolumeLoader.js";

/** Recreates a `LoadSpec` that has just been sent to/from a worker to restore three.js object prototypes */
export function rebuildLoadSpec(spec: LoadSpec): LoadSpec {
  return {
    ...spec,
    subregion: new Box3(new Vector3().copy(spec.subregion.min), new Vector3().copy(spec.subregion.max)),
  };
}
