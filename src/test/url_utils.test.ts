import { describe, it, expect } from "vitest";

import { remapUri } from "../utils/url_utils.js";

describe("remapUrl", () => {
  it("does not map HTTP URLs", () => {
    expect(remapUri("http://example.com/image.tif")).toBe("http://example.com/image.tif");
  });

  it("does not map HTTPS URLs", () => {
    expect(remapUri("https://example.com/image.tif")).toBe("https://example.com/image.tif");
  });

  it("trims whitespace from the URL", () => {
    expect(remapUri(" https://example.com/image.tif ")).toBe("https://example.com/image.tif");
  });

  it("maps S3 URLs", () => {
    expect(remapUri("s3://allencell/aics/example/data.zarr")).toBe(
      "https://allencell.s3.amazonaws.com/aics/example/data.zarr"
    );
  });

  it("maps GCS URLs", () => {
    expect(remapUri("gs://my-bucket/path/to/data.ome.tif")).toBe(
      "https://storage.googleapis.com/my-bucket/path/to/data.ome.tif"
    );
  });

  it("maps VAST file paths", () => {
    expect(remapUri("/allen/aics/example/data.zarr")).toBe("https://vast-files.int.allencell.org/example/data.zarr");
  });

  it("maps FMS file paths", () => {
    expect(remapUri("/allen/programs/allencell/data/proj0/folder/some-data.ome.zarr")).toBe(
      "https://s3.us-west-2.amazonaws.com/production.files.allencell.org/folder/some-data.ome.zarr"
    );
  });

  it("maps example Human Organ Atlas GCS URL", () => {
    expect(
      remapUri(
        "gs://ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/A186/lung-right/24.132um_complete-organ_bm18.ome.zarr/"
      )
    ).toBe(
      "https://storage.googleapis.com/ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/A186/lung-right/24.132um_complete-organ_bm18.ome.zarr/"
    );
  });
});
