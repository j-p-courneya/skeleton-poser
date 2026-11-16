import * as THREE from 'three';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform sampler2D tData; uniform sampler2D tDepth;
uniform vec2 fullRes;            // size of the whole (virtual) frame in pixels
uniform vec2 uvOff; uniform vec2 uvScale; // this render's window inside the whole frame
uniform float near, far, tanHalf, aspect;
uniform float lineW;
uniform vec3 ink, fillCol, bg;
uniform float fillOn, bgOn, inkOn;
uniform int shadeMode; uniform float shadeAmt, shadeDens; uniform vec3 lightDir;
uniform float rough, distress;
uniform int mode;
varying vec2 vUv;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.,0.)), f.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), f.x), f.y); }
float linZ(float z){ float n = z*2.0-1.0; return 2.0*near*far/(far+near-n*(far-near)); }
vec2 toFull(vec2 uv){ return uvOff + uv*uvScale; }
vec3 vpos(vec2 uv, float d){ return vec3((toFull(uv)*2.0-1.0)*vec2(aspect*tanHalf, tanHalf)*d, -d); }

void main(){
  vec2 fuv = toFull(vUv);
  vec2 fpx = fuv * fullRes;                 // pixel position in the whole frame
  vec2 px = uvScale / fullRes;              // one frame pixel, in local uv... inverted below
  px = 1.0 / (fullRes * uvScale);
  vec2 uv = vUv;
  if (rough > 0.0) {
    vec2 q = fpx / (lineW * 5.0);
    uv += (vec2(vnoise(q), vnoise(q + 31.7)) - 0.5) * 2.0 * rough * lineW * px;
  }
  vec4 c = texture2D(tData, uv);
  bool objC = c.a > 0.5;
  bool fillC = objC && dot(c.rgb, c.rgb) < 0.04;
  float dC = linZ(texture2D(tDepth, uv).x);
  vec3 nC = normalize(c.rgb*2.0-1.0);
  vec3 pC = vpos(uv, dC);
  float line = 0.0;
  for (int ring = 0; ring < 3; ring++) {
    float rr = ring == 0 ? 1.0 : (ring == 1 ? 0.62 : 0.3);
    int cnt = ring == 0 ? 16 : (ring == 1 ? 10 : 5);
    for (int k = 0; k < 16; k++) {
      if (k >= cnt) break;
      float a = (float(k) + 0.5*float(ring)) / float(cnt) * 6.2831853;
      vec2 uvS = uv + vec2(cos(a), sin(a)) * rr * lineW * px;
      vec4 s = texture2D(tData, uvS);
      if (s.a < 0.5) continue;
      if (!objC) { line = 1.0; continue; }
      if (fillC || dot(s.rgb, s.rgb) < 0.04) continue;
      float dS = linZ(texture2D(tDepth, uvS).x);
      vec3 pS = vpos(uvS, dS);
      if (dot(nC, pS - pC) > 0.0026 || dC - dS > 0.04) line = 1.0;
    }
  }
  float inkA = line;
  if (fillC) inkA = 1.0;
  vec3 L = normalize(lightDir);
  if (objC && !fillC && shadeMode > 0 && inkA < 0.5) {
    float lam = dot(nC, L);
    float dark = clamp((0.4 - lam) / 0.95, 0.0, 1.0) * shadeAmt;
    vec2 p = fuv * vec2(aspect, 1.0) * shadeDens;
    if (shadeMode == 1) {
      float v = abs(fract(p.x + p.y) - 0.5) * 2.0;
      if (dark > 0.1 && v < dark * 0.85) inkA = 1.0;
      if (dark > 0.6) { float v2 = abs(fract(p.x - p.y) - 0.5) * 2.0; if (v2 < (dark - 0.6) * 1.5) inkA = 1.0; }
    } else if (shadeMode == 2) {
      vec2 r = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p;
      vec2 cell = fract(r) - 0.5;
      if (length(cell) < sqrt(dark) * 0.5) inkA = 1.0;
    } else {
      vec2 g = p * 2.4; vec2 id = floor(g); vec2 f = fract(g) - 0.5;
      vec2 jit = (vec2(hash(id), hash(id + 7.3)) - 0.5) * 0.6;
      if (hash(id + 3.1) < dark * 1.15 && length(f - jit) < 0.26) inkA = 1.0;
    }
  }
  if (distress > 0.0 && inkA > 0.5) {
    float n = vnoise(fpx / (lineW * 1.3)) * 0.6 + vnoise(fpx / (lineW * 4.0) + 9.1) * 0.4;
    if (n < distress * 0.55) inkA = 0.0;
  }
  vec4 o;
  if (mode == 1) {
    if (objC) { float l = fillC ? 0.06 : 0.32 + 0.68 * max(dot(nC, L), 0.0); o = vec4(vec3(0.94, 0.91, 0.83) * l, 1.0); }
    else o = vec4(bg * bgOn, bgOn);
  } else if (inkA > 0.5 && inkOn > 0.5) o = vec4(ink, 1.0);
  else if ((objC || inkA > 0.5) && fillOn > 0.5) o = vec4(fillCol, 1.0);
  else o = vec4(bg * bgOn, bgOn);
  gl_FragColor = o;
}`;

export const hexToRgb = hex => {
  const n = parseInt(hex.replace('#', ''), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export class InkRenderer {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.uniforms = {
      tData: { value: null }, tDepth: { value: null },
      fullRes: { value: new THREE.Vector2(1, 1) },
      uvOff: { value: new THREE.Vector2(0, 0) }, uvScale: { value: new THREE.Vector2(1, 1) },
      near: { value: camera.near }, far: { value: camera.far }, tanHalf: { value: 1 }, aspect: { value: 1 },
      lineW: { value: 2 },
      ink: { value: hexToRgb('#161616') }, fillCol: { value: hexToRgb('#f3ead7') }, bg: { value: hexToRgb('#e9dcc9') },
      fillOn: { value: 0 }, bgOn: { value: 1 }, inkOn: { value: 1 },
      shadeMode: { value: 1 }, shadeAmt: { value: 0.7 }, shadeDens: { value: 150 },
      lightDir: { value: new THREE.Vector3(-0.5, 0.6, 0.62) },
      rough: { value: 0.25 }, distress: { value: 0 }, mode: { value: 0 },
    };
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false }));
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene(); this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.lineWeight = 1.7; // in thousandths of the frame height
    this.rt = null;
  }
  makeRT(w, h) {
    const rt = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
    rt.depthTexture = new THREE.DepthTexture(w, h);
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
    return rt;
  }
  setSize(w, h) {
    if (this.rt) { this.rt.depthTexture.dispose(); this.rt.dispose(); }
    this.rt = this.makeRT(w, h); this.w = w; this.h = h;
  }
  _camUniforms(fullW, fullH) {
    const u = this.uniforms, cam = this.camera;
    u.tanHalf.value = Math.tan((cam.fov * Math.PI / 180) / 2);
    u.aspect.value = fullW / fullH;
    u.near.value = cam.near; u.far.value = cam.far;
    u.fullRes.value.set(fullW, fullH);
    u.lineW.value = Math.max(0.6, this.lineWeight * fullH / 1000);
  }
  renderData(rt) {
    const r = this.renderer;
    r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(); r.render(this.scene, this.camera);
  }
  // live preview to the canvas
  render() {
    const r = this.renderer, u = this.uniforms;
    this.renderData(this.rt);
    this._camUniforms(this.w, this.h);
    u.uvOff.value.set(0, 0); u.uvScale.value.set(1, 1);
    u.tData.value = this.rt.texture; u.tDepth.value = this.rt.depthTexture;
    r.setRenderTarget(null); r.setClearColor(0x000000, 0); r.clear();
    r.render(this.quadScene, this.quadCam);
  }
  // bounding box of the figure in frame uv (y measured from the top), from a small render
  measure() {
    const cam = this.camera, h = 400, w = Math.max(8, Math.round(h * cam.aspect));
    const rt = this.makeRT(w, h);
    this.renderData(rt);
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    rt.depthTexture.dispose(); rt.dispose();
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (buf[(y * w + x) * 4 + 3] > 0) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    this.renderer.setRenderTarget(null);
    if (x1 < 0) return null;
    return { x0: x0 / w, x1: (x1 + 1) / w, top: 1 - (y1 + 1) / h, bottom: 1 - y0 / h };
  }
  // high-resolution, tightly cropped, transparent render. Returns {w, h, data(Uint8ClampedArray, top row first)}.
  renderCrop(longSide, overrides = {}) {
    const r = this.renderer, u = this.uniforms, cam = this.camera;
    const box = this.measure();
    if (!box) return null;
    const pad = 0.012 + this.lineWeight / 1000 * 2;
    const bx0 = Math.max(0, box.x0 - pad / cam.aspect), bx1 = Math.min(1, box.x1 + pad / cam.aspect);
    const by0 = Math.max(0, box.top - pad), by1 = Math.min(1, box.bottom + pad);
    const bw = bx1 - bx0, bh = by1 - by0;
    const max = Math.min(r.capabilities.maxTextureSize, 8192);
    const L = Math.min(longSide, max);
    const fullH = L / Math.max(bh, bw * cam.aspect), fullW = fullH * cam.aspect;
    const w = Math.max(2, Math.round(bw * fullW)), h = Math.max(2, Math.round(bh * fullH));
    const x = Math.round(bx0 * fullW), y = Math.round(by0 * fullH);
    cam.setViewOffset(fullW, fullH, x, y, w, h); cam.updateProjectionMatrix();
    const rt = this.makeRT(w, h);
    const out = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this.renderData(rt);
    this._camUniforms(fullW, fullH);
    u.uvOff.value.set(x / fullW, (fullH - y - h) / fullH); u.uvScale.value.set(w / fullW, h / fullH);
    u.tData.value = rt.texture; u.tDepth.value = rt.depthTexture;
    const keep = { bgOn: u.bgOn.value, mode: u.mode.value, fillOn: u.fillOn.value, inkOn: u.inkOn.value };
    u.bgOn.value = 0; u.mode.value = 0;
    for (const k in overrides) u[k].value = overrides[k];
    r.setRenderTarget(out); r.setClearColor(0x000000, 0); r.clear();
    r.render(this.quadScene, this.quadCam);
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(out, 0, 0, w, h, buf);
    for (const k in keep) u[k].value = keep[k];
    r.setRenderTarget(null);
    cam.clearViewOffset(); cam.updateProjectionMatrix();
    rt.depthTexture.dispose(); rt.dispose(); out.dispose();
    const data = new Uint8ClampedArray(w * h * 4), row = w * 4;
    for (let yy = 0; yy < h; yy++) data.set(buf.subarray((h - 1 - yy) * row, (h - yy) * row), yy * row);
    return { w, h, data };
  }
}
