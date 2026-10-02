import { Axis } from "../types.js";
import { VolumeRenderSettings } from "../VolumeRenderSettings.js";
import { Vector3 } from "three";

describe("VolumeRenderSettingUtils", () => {
  it("deeply-copies bounds", () => {
    const s1 = new VolumeRenderSettings();
    const s1BMax = new Vector3(9.0, 9.0, 9.0);
    s1.bounds.bmax = s1BMax;

    const s2 = s1.clone();

    // Values should be the same
    expect(s1.bounds.bmax.equals(s1BMax)).to.be.true;
    expect(s2.bounds.bmax.equals(s1BMax)).to.be.true;
    expect(s1.isEqual(s2)).to.be.true;

    const s2BMax = new Vector3(1.0, 2.0, 3.0);
    s2.bounds.bmax = s2BMax;
    expect(s2.bounds.bmax.equals(s2BMax)).to.be.true;
    expect(s1.bounds.bmax.equals(s2BMax)).to.be.false;
  });

  it("deeply-copies arrays", () => {
    const s1 = new VolumeRenderSettings();
    const glossiness = [4.0, 3.0, 1.0];
    s1.glossiness = glossiness;
    const s2 = s1.clone();

    expect(s1.glossiness).to.deep.equal(glossiness);
    expect(s2.glossiness).to.deep.equal(glossiness);

    s2.glossiness[1] = 17.0;

    // s1 should not change.
    expect(s1.glossiness).to.deep.equal(glossiness);
    expect(s2.glossiness).to.deep.equal([4.0, 17.0, 1.0]);
    expect(s1.glossiness).to.not.deep.equal(s2.glossiness);
  });

  it("can compare against itself", () => {
    const s1 = new VolumeRenderSettings();
    expect(s1.isEqual(s1)).to.be.true;
  });

  it("can compare settings objects", () => {
    const s1 = new VolumeRenderSettings();
    const s2 = new VolumeRenderSettings();

    expect(s1.isEqual(s2)).to.be.true;
    expect(s2.isEqual(s1)).to.be.true;

    // Change boolean field
    s2.isOrtho = !s2.isOrtho;
    expect(s1.isEqual(s2)).to.be.false;
    expect(s2.isEqual(s1)).to.be.false;

    // Change array property
    const s3 = new VolumeRenderSettings();
    s3.specular[0][1] = 15;
    expect(s1.isEqual(s3)).to.be.false;
    expect(s3.isEqual(s1)).to.be.false;

    // Change bounds
    const s4 = new VolumeRenderSettings();
    s4.bounds.bmax = new Vector3(-1, -2, -3);
    expect(s1.isEqual(s4)).to.be.false;
    expect(s4.isEqual(s1)).to.be.false;
    s4.bounds.bmax = s1.bounds.bmax;
    expect(s4.isEqual(s1)).to.be.true;
    expect(s1.isEqual(s4)).to.be.true;
  });

  it("flags string changes", () => {
    const s1 = new VolumeRenderSettings();
    const s2 = new VolumeRenderSettings();

    s1.viewAxis = Axis.NONE;
    s2.viewAxis = Axis.X;
    expect(s1.isEqual(s2)).to.be.false;
  });
});
