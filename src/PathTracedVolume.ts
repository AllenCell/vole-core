import {
  DataTexture,
  Data3DTexture,
  FloatType,
  Matrix4,
  Mesh,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  LinearFilter,
  NearestFilter,
  OrthographicCamera,
  WebGLRenderer,
} from "three";

import { renderToBufferVertShader, copyImageFragShader } from "./constants/basicShaders.js";
import { denoiseFragmentShaderSrc, denoiseShaderUniforms } from "./constants/denoiseShader.js";
import { pathtraceOutputFragmentShaderSrc, pathtraceOutputShaderUniforms } from "./constants/pathtraceOutputShader.js";
import { pathTracingFragmentShaderSrc, pathTracingUniforms } from "./constants/volumePTshader.js";

import { LUT_ARRAY_LENGTH } from "./Lut.js";
import Volume from "./Volume.js";
import { FUSE_DISABLED_RGB_COLOR, type FuseChannel, isOrthographicCamera } from "./types.js";
import { Light } from "./Light.js";
import type { VolumeRenderImpl } from "./VolumeRenderImpl.js";
import { VolumeRenderSettings, SettingsFlags } from "./VolumeRenderSettings.js";
import Channel from "./Channel.js";
import RenderToBuffer from "./RenderToBuffer.js";

export default class PathTracedVolume implements VolumeRenderImpl {
  private settings: VolumeRenderSettings;

  private volume: Volume;
  private viewChannels: number[]; // should have 4 or less elements

  private volumeTexture: Data3DTexture;

  private cameraIsMoving: boolean;
  private sampleCounter: number;
  private frameCounter: number;

  private pathTracingUniforms = pathTracingUniforms();
  private pathTracingRenderToBuffer: RenderToBuffer;
  private pathTracingRenderTarget: WebGLRenderTarget;

  private screenTextureRenderToBuffer: RenderToBuffer;
  private screenTextureRenderTarget: WebGLRenderTarget;

  private denoiseShaderUniforms = denoiseShaderUniforms();
  private screenOutputShaderUniforms = pathtraceOutputShaderUniforms();
  private screenOutputDenoiseMaterial: ShaderMaterial;
  private screenOutputMaterial: ShaderMaterial;
  private screenOutputGeometry: PlaneGeometry;
  private screenOutputMesh: Mesh;

  private gradientDelta: number;
  private renderUpdateListener?: (iteration: number) => void;

  /**
   * Creates a new PathTracedVolume.
   * @param volume The volume that this renderer should render data from.
   * @param settings Optional settings object. If set, updates the renderer with
   * the given settings. Otherwise, uses the default VolumeRenderSettings.
   */
  constructor(volume: Volume, settings: VolumeRenderSettings = new VolumeRenderSettings(volume)) {
    this.volume = volume;
    this.viewChannels = [-1, -1, -1, -1];

    // create volume texture
    const { x: sx, y: sy, z: sz } = volume.imageInfo.subregionSize;
    const data = new Uint8Array(sx * sy * sz * 4).fill(0);
    // defaults to rgba and unsignedbytetype so dont need to supply format this time.
    this.volumeTexture = new Data3DTexture(data, sx, sy, sz);
    this.volumeTexture.minFilter = this.volumeTexture.magFilter = LinearFilter;
    this.volumeTexture.generateMipmaps = false;

    this.volumeTexture.needsUpdate = true;

    // create Lut textures
    // empty array
    const lutData = new Uint8Array(LUT_ARRAY_LENGTH * 4).fill(1);
    const lut0 = new DataTexture(lutData, 256, 4, RGBAFormat, UnsignedByteType);
    lut0.minFilter = lut0.magFilter = LinearFilter;
    lut0.needsUpdate = true;
    this.pathTracingUniforms.gLutTexture.value = lut0;

    this.cameraIsMoving = false;
    this.sampleCounter = 0;
    this.frameCounter = 0;

    this.pathTracingRenderTarget = new WebGLRenderTarget(2, 2, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      format: RGBAFormat,
      type: FloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    this.screenTextureRenderTarget = new WebGLRenderTarget(2, 2, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      format: RGBAFormat,
      type: FloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });

    // initialize texture.
    this.pathTracingUniforms.volumeTexture.value = this.volumeTexture;
    this.pathTracingUniforms.tPreviousTexture.value = this.screenTextureRenderTarget.texture;

    this.pathTracingRenderToBuffer = new RenderToBuffer(pathTracingFragmentShaderSrc, this.pathTracingUniforms);
    this.screenTextureRenderToBuffer = new RenderToBuffer(copyImageFragShader, {
      image: { value: this.pathTracingRenderTarget.texture },
    });

    this.screenOutputGeometry = new PlaneGeometry(2, 2);

    this.screenOutputMaterial = new ShaderMaterial({
      uniforms: this.screenOutputShaderUniforms,
      vertexShader: renderToBufferVertShader,
      fragmentShader: pathtraceOutputFragmentShaderSrc,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
      transparent: true,
    });

    this.denoiseShaderUniforms = denoiseShaderUniforms();
    this.screenOutputDenoiseMaterial = new ShaderMaterial({
      uniforms: this.denoiseShaderUniforms,
      vertexShader: renderToBufferVertShader,
      fragmentShader: denoiseFragmentShaderSrc,
      depthWrite: false,
      depthTest: false,
      blending: NormalBlending,
      transparent: true,
    });

    this.screenOutputMaterial.uniforms.tTexture0.value = this.pathTracingRenderTarget.texture;
    this.screenOutputDenoiseMaterial.uniforms.tTexture0.value = this.pathTracingRenderTarget.texture;

    this.screenOutputMesh = new Mesh(this.screenOutputGeometry, this.screenOutputMaterial);

    this.gradientDelta = 1.0 / Math.max(sx, Math.max(sy, sz));
    const invGradientDelta = 1.0 / this.gradientDelta; // a voxel count...

    this.pathTracingUniforms.gGradientDeltaX.value = new Vector3(this.gradientDelta, 0, 0);
    this.pathTracingUniforms.gGradientDeltaY.value = new Vector3(0, this.gradientDelta, 0);
    this.pathTracingUniforms.gGradientDeltaZ.value = new Vector3(0, 0, this.gradientDelta);
    // can this be a per-x,y,z value?
    this.pathTracingUniforms.gInvGradientDelta.value = invGradientDelta; // a voxel count
    this.pathTracingUniforms.gGradientFactor.value = 50.0; // related to voxel counts also

    // Update settings
    this.updateSettings(settings);
    this.settings = settings; // turns off ts initialization warning

    // bounds will go from 0 to physicalSize
    const physicalSize = this.getNormVolumeSize();

    this.pathTracingUniforms.gInvAaBbMax.value = new Vector3(
      1.0 / physicalSize.x,
      1.0 / physicalSize.y,
      1.0 / physicalSize.z
    ).divide(volume.normRegionSize);
    this.updateLightsSecondary();
  }

  public cleanup(): void {
    // warning do not use after cleanup is called!
    this.volumeTexture.dispose();
  }

  public setRenderUpdateListener(callback?: (iteration: number) => void): void {
    this.renderUpdateListener = callback;
  }

  public resetProgress(): void {
    if (this.sampleCounter !== 0 && this.renderUpdateListener) {
      this.renderUpdateListener(0);
    }
    this.sampleCounter = 0;
  }

  private getNormVolumeSize(): Vector3 {
    return this.volume.normPhysicalSize.clone().multiply(this.settings.scale);
  }

  /**
   * If the new settings have changed, applies all changes to this volume renderer.
   * @param newSettings
   * @returns
   */
  public updateSettings(newSettings: VolumeRenderSettings, dirtyFlags?: number | SettingsFlags): void {
    if (dirtyFlags === undefined) {
      dirtyFlags = SettingsFlags.ALL;
    }
    this.settings = newSettings;

    // Update resolution
    if (dirtyFlags & SettingsFlags.SAMPLING) {
      const resolution = this.settings.resolution.clone();
      const dpr = window.devicePixelRatio ? window.devicePixelRatio : 1.0;
      const nx = Math.floor((resolution.x * this.settings.pixelSamplingRate) / dpr);
      const ny = Math.floor((resolution.y * this.settings.pixelSamplingRate) / dpr);
      this.pathTracingUniforms.uResolution.value.x = nx;
      this.pathTracingUniforms.uResolution.value.y = ny;
      this.pathTracingRenderTarget.setSize(nx, ny);
      this.screenTextureRenderTarget.setSize(nx, ny);

      // update ray step size
      this.pathTracingUniforms.gStepSize.value = this.settings.primaryRayStepSize * this.gradientDelta;
      this.pathTracingUniforms.gStepSizeShadow.value = this.settings.secondaryRayStepSize * this.gradientDelta;
    }

    if (dirtyFlags & SettingsFlags.TRANSFORM) {
      this.pathTracingUniforms.flipVolume.value = this.settings.flipAxes;
    }

    if (dirtyFlags & SettingsFlags.MATERIAL) {
      this.pathTracingUniforms.gDensityScale.value = this.settings.density * 150.0;
      this.updateMaterial();
    }

    // update bounds
    if (dirtyFlags & SettingsFlags.ROI) {
      const { normRegionSize, normRegionOffset } = this.volume;
      const { bmin, bmax } = this.settings.bounds;
      const scaledSize = this.getNormVolumeSize();

      const sizeMin = normRegionOffset.clone().subScalar(0.5).multiply(scaledSize);
      const sizeMax = normRegionOffset.clone().add(normRegionSize).subScalar(0.5).multiply(scaledSize);

      const clipMin = bmin.clone().multiply(scaledSize);
      this.pathTracingUniforms.gClippedAaBbMin.value = clipMin.clamp(sizeMin, sizeMax);

      const clipMax = bmax.clone().multiply(scaledSize);
      this.pathTracingUniforms.gClippedAaBbMax.value = clipMax.clamp(sizeMin, sizeMax);

      this.pathTracingUniforms.gVolCenter.value = this.volume.getContentCenter().multiply(this.settings.scale);
    }

    if (dirtyFlags & SettingsFlags.CAMERA) {
      this.updateExposure(this.settings.brightness);
    }

    if (dirtyFlags & SettingsFlags.MASK_ALPHA) {
      // Update channel and alpha mask if they have changed
      this.updateVolumeData4();
    }
    if (dirtyFlags & SettingsFlags.VIEW) {
      this.pathTracingUniforms.gCamera.value.mIsOrtho = this.settings.isOrtho ? 1 : 0;
    }

    if (dirtyFlags & SettingsFlags.SAMPLING) {
      this.volumeTexture.minFilter = this.volumeTexture.magFilter = newSettings.useInterpolation
        ? LinearFilter
        : NearestFilter;
      this.volumeTexture.needsUpdate = true;
    }

    this.resetProgress();
  }

  public updateVolumeDimensions(): void {
    this.updateSettings(this.settings, SettingsFlags.ROI);
  }

  public doRender(renderer: WebGLRenderer, camera: PerspectiveCamera | OrthographicCamera): void {
    if (!this.volumeTexture) {
      return;
    }

    if (this.cameraIsMoving) {
      this.resetProgress();
      this.frameCounter += 1.0;
    } else {
      this.sampleCounter += 1.0;
      this.frameCounter += 1.0;
      if (this.renderUpdateListener) {
        this.renderUpdateListener(this.sampleCounter);
      }
    }

    this.pathTracingUniforms.uSampleCounter.value = this.sampleCounter;
    this.pathTracingUniforms.uFrameCounter.value = this.frameCounter;

    // CAMERA
    // force the camera to update its world matrix.
    camera.updateMatrixWorld(true);

    // rotate lights with camera, as if we are tumbling the volume with a fixed camera and world lighting.
    // this code is analogous to this threejs code from View3d.preRender:
    // this.scene.getObjectByName('lightContainer').rotation.setFromRotationMatrix(this.canvas3d.camera.matrixWorld);
    const mycamxform = camera.matrixWorld.clone();
    mycamxform.setPosition(new Vector3(0, 0, 0));
    this.updateLightsSecondary(mycamxform);

    let mydir = new Vector3();
    mydir = camera.getWorldDirection(mydir);
    const myup = new Vector3().copy(camera.up);
    // don't rotate this vector.  we are using translation as the pivot point of the object, and THEN rotating.
    const mypos = new Vector3().copy(camera.position);

    // apply volume translation and rotation:
    // rotate camera.up, camera.direction, and camera position by inverse of volume's modelview
    const m = new Matrix4().makeRotationFromQuaternion(new Quaternion().setFromEuler(this.settings.rotation).invert());
    mypos.sub(this.settings.translation);
    mypos.applyMatrix4(m);
    myup.applyMatrix4(m);
    mydir.applyMatrix4(m);

    this.pathTracingUniforms.gCamera.value.mIsOrtho = isOrthographicCamera(camera) ? 1 : 0;
    this.pathTracingUniforms.gCamera.value.mFrom.copy(mypos);
    this.pathTracingUniforms.gCamera.value.mN.copy(mydir);
    this.pathTracingUniforms.gCamera.value.mU.crossVectors(this.pathTracingUniforms.gCamera.value.mN, myup).normalize();
    this.pathTracingUniforms.gCamera.value.mV
      .crossVectors(this.pathTracingUniforms.gCamera.value.mU, this.pathTracingUniforms.gCamera.value.mN)
      .normalize();

    // the choice of y = scale/aspect or x = scale*aspect is made here to match up with the other raymarch volume
    const fScale = isOrthographicCamera(camera)
      ? Math.abs(camera.top) / camera.zoom
      : Math.tan((0.5 * camera.fov * Math.PI) / 180.0);

    const aspect = this.pathTracingUniforms.uResolution.value.x / this.pathTracingUniforms.uResolution.value.y;
    this.pathTracingUniforms.gCamera.value.mScreen.set(
      -fScale * aspect,
      fScale * aspect,
      // the "0" Y pixel will be at +Scale.
      fScale,
      -fScale
    );
    const scr = this.pathTracingUniforms.gCamera.value.mScreen;
    this.pathTracingUniforms.gCamera.value.mInvScreen.set(
      // the amount to increment for each pixel
      (scr.y - scr.x) / this.pathTracingUniforms.uResolution.value.x,
      (scr.w - scr.z) / this.pathTracingUniforms.uResolution.value.y
    );

    const denoiseLerpC = 0.33 * (Math.max(this.sampleCounter - 1, 1.0) * 0.035);
    if (denoiseLerpC > 0.0 && denoiseLerpC < 1.0) {
      this.screenOutputDenoiseMaterial.uniforms.gDenoiseLerpC.value = denoiseLerpC;
      this.screenOutputMesh.material = this.screenOutputDenoiseMaterial;
    } else {
      this.screenOutputMesh.material = this.screenOutputMaterial;
    }
    this.screenOutputDenoiseMaterial.uniforms.gDenoisePixelSize.value.x = this.pathTracingUniforms.uResolution.value.x;
    this.screenOutputDenoiseMaterial.uniforms.gDenoisePixelSize.value.y = this.pathTracingUniforms.uResolution.value.y;

    // RENDERING in 3 steps

    // STEP 1
    // Perform PathTracing and Render(save) into pathTracingRenderTarget

    // This is currently rendered as a fullscreen quad with no camera transform in the vertex shader!
    // It is also composited with screenTextureRenderTarget's texture.
    // (Read previous screenTextureRenderTarget to use as a new starting point to blend with)
    this.pathTracingRenderToBuffer.render(renderer, this.pathTracingRenderTarget);

    // STEP 2
    // Render(copy) the final pathTracingScene output(above) into screenTextureRenderTarget
    // This will be used as a new starting point for Step 1 above
    this.screenTextureRenderToBuffer.render(renderer, this.screenTextureRenderTarget);

    // STEP 3
    // Render full screen quad with generated pathTracingRenderTarget in STEP 1 above.
    // After the image is gamma corrected, it will be shown on the screen as the final accumulated output
    // DMT - this step is handled by the threeJsPanel.
    // tell the threejs panel to use the quadCamera to render this scene.

    // renderer.render( this.screenOutputScene, this.quadCamera );
    renderer.setRenderTarget(null);
  }

  public get3dObject(): Mesh {
    return this.screenOutputMesh;
  }

  //////////////////////////////////////////
  //////////////////////////////////////////

  onStartControls(): void {
    this.cameraIsMoving = true;
  }

  onChangeControls(): void {
    // this.cameraIsMoving = true;
  }

  onEndControls(): void {
    this.cameraIsMoving = false;
    this.resetProgress();
  }

  viewpointMoved(): void {
    this.resetProgress();
  }

  updateActiveChannels(channelColors: FuseChannel[], channelData: Channel[]): void {
    const ch = [-1, -1, -1, -1];
    let activeChannel = 0;
    const NC = this.volume.imageInfo.numChannels;
    const maxch = 4;
    for (let i = 0; i < NC && activeChannel < maxch; ++i) {
      // check that channel is not disabled and is loaded
      if (channelColors[i].rgbColor !== FUSE_DISABLED_RGB_COLOR && channelData[i].loaded) {
        ch[activeChannel] = i;
        activeChannel++;
      }
    }

    const unchanged = ch.every((elem, index) => elem === this.viewChannels[index], this);
    if (unchanged) {
      return;
    }

    this.pathTracingUniforms.gNChannels.value = activeChannel;

    this.viewChannels = ch;
    // update volume data according to channels selected.
    this.updateVolumeData4();
    this.resetProgress();
    this.updateLuts(channelColors, channelData);
    this.updateMaterial();
  }

  updateVolumeData4(): void {
    const { x: sx, y: sy, z: sz } = this.volume.imageInfo.subregionSize;

    const data = new Uint8Array(sx * sy * sz * 4);
    data.fill(0);

    for (let i = 0; i < 4; ++i) {
      const ch = this.viewChannels[i];
      if (ch === -1) {
        continue;
      }

      const volumeChannel = this.volume.getChannel(ch);
      for (let iz = 0; iz < sz; ++iz) {
        for (let iy = 0; iy < sy; ++iy) {
          for (let ix = 0; ix < sx; ++ix) {
            // TODO expand to 16-bpp raw intensities?
            data[i + ix * 4 + iy * 4 * sx + iz * 4 * sx * sy] =
              255 * volumeChannel.normalizeRaw(volumeChannel.getIntensity(ix, iy, iz));
          }
        }
      }
      if (this.settings.maskChannelIndex !== -1 && this.settings.maskAlpha < 1.0) {
        const maskChannel = this.volume.getChannel(this.settings.maskChannelIndex);
        // const maskMax = maskChannel.getHistogram().dataMax;
        const maskAlpha = this.settings.maskAlpha;
        for (let iz = 0; iz < sz; ++iz) {
          for (let iy = 0; iy < sy; ++iy) {
            for (let ix = 0; ix < sx; ++ix) {
              // nonbinary masking
              // maskVal = maskChannel.getIntensity(ix,iy,iz) * maskAlpha / maskMax;

              // binary masking
              const maskVal = maskChannel.getIntensity(ix, iy, iz) > 0 ? 1.0 : maskAlpha;

              data[i + ix * 4 + iy * 4 * sx + iz * 4 * sx * sy] *= maskVal;
            }
          }
        }
      }
    }
    // defaults to rgba and unsignedbytetype so dont need to supply format this time.
    this.volumeTexture.image.data?.set(data);
    this.volumeTexture.needsUpdate = true;
  }

  updateLuts(channelColors: FuseChannel[], channelData: Channel[]): void {
    for (let i = 0; i < this.pathTracingUniforms.gNChannels.value; ++i) {
      const channel = this.viewChannels[i];
      const combinedLut = channelData[channel].combineLuts(channelColors[channel].rgbColor);

      const { image } = this.pathTracingUniforms.gLutTexture.value;
      if (image.data === null) {
        image.data = new Uint8Array(LUT_ARRAY_LENGTH);
      }
      image.data.set(combinedLut, i * LUT_ARRAY_LENGTH);

      // TODO expand to 16-bpp raw intensities?
      this.pathTracingUniforms.gIntensityMax.value.setComponent(
        i,
        this.volume.channels[channel].histogram.getMax() / 255.0
      );
      this.pathTracingUniforms.gIntensityMin.value.setComponent(
        i,
        this.volume.channels[channel].histogram.getMin() / 255.0
      );
    }
    this.pathTracingUniforms.gLutTexture.value.needsUpdate = true;

    this.resetProgress();
  }

  // image is a material interface that supports per-channel color, spec,
  // emissive, glossiness
  updateMaterial(): void {
    for (let c = 0; c < this.viewChannels.length; ++c) {
      const i = this.viewChannels[c];
      if (i > -1) {
        // diffuse color is actually blended into the LUT now.
        const channelData = this.volume.getChannel(i);
        const combinedLut = channelData.combineLuts(this.settings.diffuse[i]);

        const { image } = this.pathTracingUniforms.gLutTexture.value;
        if (image.data === null) {
          image.data = new Uint8Array(LUT_ARRAY_LENGTH);
        }

        image.data.set(combinedLut, c * LUT_ARRAY_LENGTH);
        this.pathTracingUniforms.gLutTexture.value.needsUpdate = true;
        this.pathTracingUniforms.gDiffuse.value[c] = new Vector3(1.0, 1.0, 1.0);

        this.pathTracingUniforms.gSpecular.value[c] = new Vector3()
          .fromArray(this.settings.specular[i])
          .multiplyScalar(1.0 / 255.0);
        this.pathTracingUniforms.gEmissive.value[c] = new Vector3()
          .fromArray(this.settings.emissive[i])
          .multiplyScalar(1.0 / 255.0);
        this.pathTracingUniforms.gGlossiness.value[c] = this.settings.glossiness[i];
      }
    }
    this.resetProgress();
  }

  updateShadingMethod(brdf: number): void {
    this.pathTracingUniforms.gShadingType.value = brdf;
    this.resetProgress();
  }

  updateShowLights(showlights: number): void {
    this.pathTracingUniforms.uShowLights.value = showlights;
    this.resetProgress();
  }

  updateExposure(e: number): void {
    // 1.0 causes division by zero.
    if (e > 0.99999) {
      e = 0.99999;
    }
    this.screenOutputMaterial.uniforms.gInvExposure.value = 1.0 / (1.0 - e) - 1.0;
    this.screenOutputDenoiseMaterial.uniforms.gInvExposure.value = 1.0 / (1.0 - e) - 1.0;
    this.resetProgress();
  }

  updateCamera(fov: number, focalDistance: number, apertureSize: number): void {
    this.pathTracingUniforms.gCamera.value.mApertureSize = apertureSize;
    this.pathTracingUniforms.gCamera.value.mFocalDistance = focalDistance;

    this.resetProgress();
  }

  updateLights(state: Light[]): void {
    // 0th light in state array is sphere light
    this.pathTracingUniforms.gLights.value[0].mColorTop = new Vector3().copy(state[0].mColorTop);
    this.pathTracingUniforms.gLights.value[0].mColorMiddle = new Vector3().copy(state[0].mColorMiddle);
    this.pathTracingUniforms.gLights.value[0].mColorBottom = new Vector3().copy(state[0].mColorBottom);

    // 1st light in state array is area light
    this.pathTracingUniforms.gLights.value[1].mColor = new Vector3().copy(state[1].mColor);
    this.pathTracingUniforms.gLights.value[1].mTheta = state[1].mTheta;
    this.pathTracingUniforms.gLights.value[1].mPhi = state[1].mPhi;
    this.pathTracingUniforms.gLights.value[1].mDistance = state[1].mDistance;
    this.pathTracingUniforms.gLights.value[1].mWidth = state[1].mWidth;
    this.pathTracingUniforms.gLights.value[1].mHeight = state[1].mHeight;

    this.updateLightsSecondary();

    this.resetProgress();
  }

  updateLightsSecondary(cameraMatrix?: Matrix4): void {
    console.log("lights secondary");
    const physicalSize = this.getNormVolumeSize();
    const bbctr = new Vector3(physicalSize.x * 0.5, physicalSize.y * 0.5, physicalSize.z * 0.5);

    for (let i = 0; i < 2; ++i) {
      const lt = this.pathTracingUniforms.gLights.value[i];
      lt.update(bbctr, cameraMatrix);
    }
  }

  // 0..1 ranges as input
  updateClipRegion(xmin: number, xmax: number, ymin: number, ymax: number, zmin: number, zmax: number): void {
    this.settings.bounds = {
      bmin: new Vector3(xmin - 0.5, ymin - 0.5, zmin - 0.5),
      bmax: new Vector3(xmax - 0.5, ymax - 0.5, zmax - 0.5),
    };
    const physicalSize = this.getNormVolumeSize();
    this.pathTracingUniforms.gClippedAaBbMin.value = new Vector3(
      xmin * physicalSize.x - 0.5 * physicalSize.x,
      ymin * physicalSize.y - 0.5 * physicalSize.y,
      zmin * physicalSize.z - 0.5 * physicalSize.z
    );
    this.pathTracingUniforms.gClippedAaBbMax.value = new Vector3(
      xmax * physicalSize.x - 0.5 * physicalSize.x,
      ymax * physicalSize.y - 0.5 * physicalSize.y,
      zmax * physicalSize.z - 0.5 * physicalSize.z
    );
    this.resetProgress();
  }

  public setZSlice(_slice: number): boolean {
    return true;
  }
}
