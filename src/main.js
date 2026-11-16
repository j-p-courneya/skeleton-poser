import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import ImageTracer from 'imagetracerjs';
import { buildSkeleton } from './skeleton.js';
import { InkRenderer, hexToRgb } from './render.js';
import { PRESETS, HAND_SHAPES } from './presets.js';

const $ = id => document.getElementById(id);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const d2r = Math.PI / 180;

// ---------- scene ----------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
renderer.autoClear = false;
const scene = new THREE.Scene();
const overlay = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 0.4, 14);
const sk = buildSkeleton();
scene.add(sk.root);
const { J, chains, hands } = sk;
const REST_POS = sk.root.position.clone();
const ink = new InkRenderer(renderer, scene, camera);

const orbit = new OrbitControls(camera, canvas);
orbit.target.set(0, 1.04, 0);
orbit.enableDamping = false;
orbit.minDistance = 0.6; orbit.maxDistance = 10;
orbit.addEventListener('change', () => { dirty = true; });

let dirty = true;
const VIEWS = { front: [0, 0.05, 1], quarter: [0.62, 0.12, 0.78], side: [1, 0.05, 0], back: [0, 0.05, -1] };
function setView(name) {
  const v = VIEWS[name], d = 6.1;
  const dir = V(v[0], v[1], v[2]).normalize();
  camera.position.copy(orbit.target).addScaledVector(dir, d);
  camera.lookAt(orbit.target); orbit.update(); dirty = true;
}

// ---------- pose state ----------
const handPose = { L: structuredClone(HAND_SHAPES.relaxed), R: structuredClone(HAND_SHAPES.relaxed) };
function distribute() {
  for (const k in chains) {
    const { proxy, nodes } = chains[k];
    for (const n of nodes) n.quaternion.identity().slerp(proxy.quaternion, 1 / nodes.length);
  }
}
function applyHands() {
  for (const S of ['L', 'R']) {
    const H = hands[S], hp = handPose[S], s = H.side;
    for (let k = 0; k < 4; k++) {
      const c = hp.curl[k], n = H.curlNodes[k];
      n[0].rotation.z = -s * c * 1.45; n[1].rotation.z = -s * c * 1.75; n[2].rotation.z = -s * c * 1.15;
      H.spreadNodes[k].rotation.x = (k - 1.5) * 0.2 * hp.spread;
    }
    H.thumb[0].rotation.set(-0.5 * (hp.spread - 0.3), 0, -s * hp.thumb * 0.9);
    H.thumb[1].rotation.z = -s * hp.thumb * 0.5; H.thumb[2].rotation.z = -s * hp.thumb * 0.9;
  }
}
function capturePose() {
  const q = {};
  for (const n in J) q[n] = J[n].quaternion.toArray().map(v => +v.toFixed(5));
  return { pos: sk.root.position.toArray().map(v => +v.toFixed(4)), q, hands: structuredClone(handPose) };
}
function applyPose(p) {
  sk.root.position.fromArray(p.pos);
  for (const n in J) { if (p.q[n]) J[n].quaternion.fromArray(p.q[n]); else J[n].quaternion.identity(); }
  if (p.hands) { handPose.L = structuredClone(p.hands.L); handPose.R = structuredClone(p.hands.R); }
  distribute(); applyHands(); sk.root.updateMatrixWorld(true); syncHandUI(); dirty = true;
}
function resetPose() {
  sk.root.position.copy(REST_POS);
  for (const n in J) J[n].quaternion.identity();
  handPose.L = structuredClone(HAND_SHAPES.relaxed); handPose.R = structuredClone(HAND_SHAPES.relaxed);
  distribute(); applyHands(); sk.root.updateMatrixWorld(true);
}
function mirrorPose() {
  const p = capturePose(), out = { pos: [-p.pos[0], p.pos[1], p.pos[2]], q: {}, hands: { L: p.hands.R, R: p.hands.L } };
  for (const n in p.q) {
    const m = n.endsWith('L') ? n.slice(0, -1) + 'R' : n.endsWith('R') ? n.slice(0, -1) + 'L' : n;
    const [x, y, z, w] = p.q[m]; out.q[n] = [x, -y, -z, w];
  }
  applyPose(out);
}

// ---------- IK ----------
const LIMBS = {
  handL: { a: 'shoulderL', b: 'elbowL', c: 'wristL', pole: [0.3, -0.4, -1] }, handR: { a: 'shoulderR', b: 'elbowR', c: 'wristR', pole: [-0.3, -0.4, -1] },
  footL: { a: 'hipL', b: 'kneeL', c: 'ankleL', pole: [0.1, 0, 1] }, footR: { a: 'hipR', b: 'kneeR', c: 'ankleR', pole: [-0.1, 0, 1] },
};
const wp = n => J[n].getWorldPosition(V(0, 0, 0));
function rotateWorld(node, from, to) {
  if (from.lengthSq() < 1e-10 || to.lengthSq() < 1e-10) return;
  const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  const pq = node.parent.getWorldQuaternion(new THREE.Quaternion());
  node.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
}
function solveIK(limb, target, pole) {
  const L = LIMBS[limb];
  sk.root.updateMatrixWorld(true);
  const S = wp(L.a), E = wp(L.b), W = wp(L.c);
  const a = E.distanceTo(S), b = W.distanceTo(E);
  const toT = target.clone().sub(S);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const dir = toT.lengthSq() > 1e-10 ? toT.normalize() : V(0, -1, 0);
  let p = pole ? pole.clone() : E.clone().sub(S);
  p.addScaledVector(dir, -p.dot(dir));
  if (p.lengthSq() < 1e-6) { p = V(...L.pole); p.addScaledVector(dir, -p.dot(dir)); }
  if (p.lengthSq() < 1e-6) p = V(1, 0, 0).addScaledVector(dir, -dir.x);
  p.normalize();
  const x = (a * a - b * b + d * d) / (2 * d), h = Math.sqrt(Math.max(a * a - x * x, 0));
  const E2 = S.clone().addScaledVector(dir, x).addScaledVector(p, h);
  const T2 = S.clone().addScaledVector(dir, d);
  rotateWorld(J[L.a], E.clone().sub(S), E2.clone().sub(S));
  sk.root.updateMatrixWorld(true);
  const E3 = wp(L.b), W3 = wp(L.c);
  rotateWorld(J[L.b], W3.sub(E3), T2.sub(E3));
  sk.root.updateMatrixWorld(true);
}

// ---------- presets ----------
// Point a joint's local Y axis along world direction y, with local X as close to world x as possible.
function aimJoint(name, y, x) {
  sk.root.updateMatrixWorld(true);
  const Y = V(...y).normalize(), X0 = V(...x);
  const Z = X0.clone().cross(Y).normalize(), X = Y.clone().cross(Z).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
  const pq = J[name].parent.getWorldQuaternion(new THREE.Quaternion());
  J[name].quaternion.copy(pq.invert().multiply(q));
}
function setEuler(name, e) { J[name].quaternion.setFromEuler(new THREE.Euler(e[0] * d2r, e[1] * d2r, e[2] * d2r, 'XYZ')); }
function applyPreset(P) {
  resetPose();
  if (P.pos) sk.root.position.set(REST_POS.x + P.pos[0], REST_POS.y + P.pos[1], REST_POS.z + P.pos[2]);
  for (const n in (P.rot || {})) setEuler(n, P.rot[n]);
  distribute(); sk.root.updateMatrixWorld(true);
  for (const limb in (P.ik || {})) { const k = P.ik[limb]; solveIK(limb, V(...k.t), k.pole ? V(...k.pole) : V(...LIMBS[limb].pole)); }
  for (const n in (P.post || {})) setEuler(n, P.post[n]);
  for (const n in (P.aim || {})) aimJoint(n, P.aim[n].y, P.aim[n].x);
  if (P.hands) { for (const S of ['L', 'R']) if (P.hands[S]) handPose[S] = structuredClone(typeof P.hands[S] === 'string' ? HAND_SHAPES[P.hands[S]] : P.hands[S]); }
  distribute(); applyHands(); sk.root.updateMatrixWorld(true); syncHandUI(); dirty = true;
}

// ---------- history ----------
const hist = []; let histIdx = -1;
function pushHistory() {
  const s = JSON.stringify(capturePose());
  if (hist[histIdx] === s) return;
  hist.length = histIdx + 1; hist.push(s); if (hist.length > 80) hist.shift();
  histIdx = hist.length - 1;
}
function undo(dir) {
  const i = histIdx + dir; if (i < 0 || i >= hist.length) return;
  histIdx = i; applyPose(JSON.parse(hist[i]));
}

// ---------- handles + gizmo ----------
const LABEL = {
  pelvis: 'Pelvis', move: 'Whole body', lumbar: 'Lower spine', chest: 'Rib cage', neck: 'Neck', head: 'Skull',
  clavicle: 'collarbone', shoulder: 'shoulder', elbow: 'elbow', wrist: 'wrist', hip: 'hip', knee: 'knee', ankle: 'ankle', hand: 'hand', foot: 'foot',
};
const labelFor = n => LABEL[n] || ((n.endsWith('L') ? 'Left ' : 'Right ') + LABEL[n.slice(0, -1)]);
const hFK = new THREE.MeshBasicMaterial({ color: 0xff7a1a, depthTest: false, transparent: true, opacity: 0.95 });
const hIK = new THREE.MeshBasicMaterial({ color: 0x1f6fff, depthTest: false, transparent: true, opacity: 0.95 });
const hSel = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
const handles = [];
const sphereG = new THREE.SphereGeometry(1, 14, 10), boxG = new THREE.BoxGeometry(1.7, 1.7, 1.7);
function addHandle(name, kind, src) {
  const mesh = new THREE.Mesh(kind === 'fk' ? sphereG : boxG, kind === 'fk' ? hFK : hIK);
  mesh.renderOrder = 10; overlay.add(mesh);
  const h = { name, kind, mesh, src, base: mesh.material };
  mesh.userData.h = h; handles.push(h);
}
for (const n of ['pelvis', 'lumbar', 'chest', 'neck', 'head']) addHandle(n, 'fk', () => wp(n));
for (const S of ['L', 'R']) {
  for (const n of ['clavicle', 'shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']) addHandle(n + S, 'fk', () => wp(n + S));
  addHandle('hand' + S, 'ik', () => hands[S].spreadNodes[1].getWorldPosition(V(0, 0, 0)));
  addHandle('foot' + S, 'ik', () => wp('toes' + S));
}
addHandle('move', 'move', () => wp('pelvis').add(V(0, -0.17, 0)));

const tc = new TransformControls(camera, canvas);
tc.setSize(0.75);
overlay.add(tc.getHelper());
let selected = null, drag = null;
function select(h) {
  if (selected) selected.mesh.material = selected.base;
  selected = h;
  if (!h) { tc.detach(); $('selName').textContent = 'Nothing selected'; dirty = true; return; }
  h.mesh.material = hSel;
  if (h.kind === 'fk') { tc.attach(J[h.name]); tc.setMode('rotate'); tc.setSpace('local'); }
  else { tc.attach(h.mesh); tc.setMode('translate'); tc.setSpace('world'); }
  $('selName').textContent = labelFor(h.name) + (h.kind === 'fk' ? ': drag a ring to rotate' : ': drag an arrow to move');
  dirty = true;
}
tc.addEventListener('dragging-changed', e => {
  orbit.enabled = !e.value;
  if (e.value) {
    sk.root.updateMatrixWorld(true);
    drag = { feet: { footL: wp('ankleL'), footR: wp('ankleR') } };
    if (selected.kind === 'ik') { const L = LIMBS[selected.name]; drag.off = selected.mesh.position.clone().sub(wp(L.c)); }
    if (selected.kind === 'move') drag.off = selected.mesh.position.clone().sub(sk.root.position);
  } else { drag = null; pushHistory(); }
});
tc.addEventListener('change', () => { dirty = true; });
tc.addEventListener('objectChange', () => {
  if (!selected || !drag) return;
  const pin = $('pinFeet').checked;
  if (selected.kind === 'fk') {
    if (chains[selected.name]) distribute();
    if (selected.name === 'pelvis' && pin) for (const f in drag.feet) solveIK(f, drag.feet[f]);
  } else if (selected.kind === 'ik') {
    solveIK(selected.name, selected.mesh.position.clone().sub(drag.off));
  } else {
    sk.root.position.copy(selected.mesh.position).sub(drag.off);
    if (pin) for (const f in drag.feet) solveIK(f, drag.feet[f]);
  }
  dirty = true;
});
function syncHandles() {
  sk.root.updateMatrixWorld(true);
  const show = $('showHandles').checked;
  for (const h of handles) {
    h.mesh.visible = show;
    if (!(drag && h === selected && h.kind !== 'fk')) h.mesh.position.copy(h.src());
    const s = camera.position.distanceTo(h.mesh.position) * 0.0038;
    h.mesh.scale.setScalar(s);
  }
  tc.getHelper().visible = show && !!selected;
}
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(ev) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let best = null, bd = 1e9;
  for (const h of handles) {
    if (!h.mesh.visible) continue;
    const p = h.mesh.position.clone().project(camera);
    const dx = (p.x - ndc.x) * r.width / 2, dy = (p.y - ndc.y) * r.height / 2, d = Math.hypot(dx, dy);
    if (d < 13 && d < bd) { bd = d; best = h; }
  }
  return best;
}
canvas.addEventListener('pointerdown', ev => {
  if (ev.button !== 0 || tc.dragging || tc.axis) return;
  const h = pick(ev); if (h) select(h);
});
const tip = $('tip');
canvas.addEventListener('pointermove', ev => {
  if (tc.dragging) { tip.hidden = true; return; }
  const h = pick(ev);
  if (h) { const r = canvas.parentElement.getBoundingClientRect(); tip.hidden = false; tip.textContent = labelFor(h.name); tip.style.left = (ev.clientX - r.left + 14) + 'px'; tip.style.top = (ev.clientY - r.top + 10) + 'px'; canvas.style.cursor = 'pointer'; }
  else { tip.hidden = true; canvas.style.cursor = ''; }
});
canvas.addEventListener('pointerleave', () => { tip.hidden = true; });

// ---------- frame loop ----------
function resize() {
  const box = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(200, Math.floor(box.width)), h = Math.max(200, Math.floor(box.height));
  const pr = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
  renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ink.setSize(Math.round(w * pr), Math.round(h * pr));
  camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
}
new ResizeObserver(resize).observe(canvas.parentElement);
function frame() {
  if (dirty) {
    dirty = false;
    syncHandles();
    ink.render();
    renderer.clearDepth();
    renderer.render(overlay, camera);
  }
  requestAnimationFrame(frame);
}

// ---------- UI ----------
const u = ink.uniforms;
function bind(id, fn, ev = 'input') { const el = $(id); el.addEventListener(ev, () => { fn(el); dirty = true; }); fn(el); }
bind('lineW', el => { ink.lineWeight = +el.value; });
bind('shadeMode', el => { u.shadeMode.value = +el.value; }, 'change');
bind('shadeAmt', el => { u.shadeAmt.value = +el.value; });
bind('shadeDens', el => { u.shadeDens.value = +el.value; });
bind('lightAng', el => { const a = +el.value * d2r; u.lightDir.value.set(Math.sin(a) * 0.78, 0.55, Math.cos(a) * 0.78 * 0.6 + 0.25); });
bind('rough', el => { u.rough.value = +el.value; });
bind('distress', el => { u.distress.value = +el.value; });
bind('inkCol', el => { u.ink.value.copy(hexToRgb(el.value)); });
bind('fillOn', el => { u.fillOn.value = el.checked ? 1 : 0; }, 'change');
bind('fillCol', el => { u.fillCol.value.copy(hexToRgb(el.value)); });
bind('bgCol', el => { u.bg.value.copy(hexToRgb(el.value)); });
bind('clay', el => { u.mode.value = el.checked ? 1 : 0; }, 'change');
bind('showHandles', () => {}, 'change');
bind('jaw', el => { J.jaw.rotation.set(+el.value * d2r, 0, 0); });
$('jaw').addEventListener('change', pushHistory);
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => setView(b.dataset.view));

function syncHandUI() {
  for (const S of ['L', 'R']) {
    $('curl' + S).value = handPose[S].curl.reduce((a, b) => a + b, 0) / 4;
    $('spread' + S).value = handPose[S].spread; $('thumb' + S).value = handPose[S].thumb;
  }
  const e = new THREE.Euler().setFromQuaternion(J.jaw.quaternion); $('jaw').value = Math.round(e.x / d2r);
}
for (const S of ['L', 'R']) {
  $('curl' + S).addEventListener('input', e => { handPose[S].curl = [0, 0, 0, 0].map(() => +e.target.value); applyHands(); dirty = true; });
  $('spread' + S).addEventListener('input', e => { handPose[S].spread = +e.target.value; applyHands(); dirty = true; });
  $('thumb' + S).addEventListener('input', e => { handPose[S].thumb = +e.target.value; applyHands(); dirty = true; });
  for (const id of ['curl', 'spread', 'thumb']) $(id + S).addEventListener('change', pushHistory);
  $('shape' + S).addEventListener('change', e => {
    if (!e.target.value) return;
    handPose[S] = structuredClone(HAND_SHAPES[e.target.value]); e.target.value = '';
    applyHands(); syncHandUI(); dirty = true; pushHistory();
  });
}

const presetBox = $('presets');
PRESETS.forEach((P, i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'chip'; b.textContent = P.name; b.id = 'preset-' + i;
  b.addEventListener('click', () => { applyPreset(P); pushHistory(); });
  presetBox.appendChild(b);
});

$('mirror').addEventListener('click', () => { mirrorPose(); pushHistory(); });
$('reset').addEventListener('click', () => { applyPreset(PRESETS[0]); pushHistory(); });
$('undo').addEventListener('click', () => undo(-1));
$('redo').addEventListener('click', () => undo(1));
$('resetJoint').addEventListener('click', () => {
  if (!selected || selected.kind !== 'fk') return;
  J[selected.name].quaternion.identity(); distribute(); dirty = true; pushHistory();
});
window.addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT' && ev.target.type === 'text') return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(ev.shiftKey ? 1 : -1); }
  else if (ev.key === 'Escape') select(null);
  else if (ev.key.toLowerCase() === 'h') { $('showHandles').checked = !$('showHandles').checked; dirty = true; }
});

// ---------- saved poses ----------
const KEY = 'skeleton-poser.poses.v1';
let saved = [];
try { saved = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { saved = []; }
function persist() { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* storage unavailable */ } }
function drawSaved() {
  const box = $('saved'); box.textContent = '';
  if (!saved.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Poses you save appear here.'; box.appendChild(p); return; }
  saved.forEach((s, i) => {
    const row = document.createElement('div'); row.className = 'saved-row';
    const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = s.name;
    b.addEventListener('click', () => { applyPose(s.pose); pushHistory(); });
    const x = document.createElement('button'); x.type = 'button'; x.className = 'ghost'; x.textContent = 'Remove'; x.setAttribute('aria-label', 'Remove ' + s.name);
    x.addEventListener('click', () => { saved.splice(i, 1); persist(); drawSaved(); });
    row.append(b, x); box.appendChild(row);
  });
}
$('savePose').addEventListener('click', () => {
  const name = $('poseName').value.trim() || 'Pose ' + (saved.length + 1);
  saved.push({ name, pose: capturePose() }); $('poseName').value = ''; persist(); drawSaved();
});
$('importPoses').addEventListener('change', async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const arr = JSON.parse(await f.text());
    for (const s of arr) if (s && s.name && s.pose && s.pose.q) saved.push({ name: String(s.name), pose: s.pose });
    persist(); drawSaved(); status('Poses added from ' + f.name + '.');
  } catch (e) { status('That file is not a pose file from this app.', true); }
  ev.target.value = '';
});
$('exportPoses').addEventListener('click', () => {
  if (!saved.length) { status('Save a pose first, then download the pose file.', true); return; }
  saveFile('skeleton-poses.json', new Blob([JSON.stringify(saved, null, 1)], { type: 'application/json' }));
});

// ---------- export ----------
function status(msg, bad) { const s = $('status'); s.textContent = msg; s.classList.toggle('bad', !!bad); }
let dl = null;
try { if (window.claude && window.claude.use) window.claude.use('downloads').then(d => { dl = d; }).catch(() => {}); } catch (e) { /* not in a host */ }
async function saveFile(filename, blob) {
  if (dl) {
    try { await dl.save({ filename, data: blob }); status('Saved ' + filename + '.'); }
    catch (e) { status(e && e.code === 'declined' ? 'Save cancelled.' : 'Could not save the file here (' + ((e && e.code) || 'error') + ').', e && e.code !== 'declined'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  status('Sent ' + filename + ' to your downloads.');
}
function toCanvas(img) {
  const c = document.createElement('canvas'); c.width = img.w; c.height = img.h;
  c.getContext('2d').putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
  return c;
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
async function exportPNG() {
  status('Rendering…');
  await new Promise(r => setTimeout(r, 30));
  const img = ink.renderCrop(+$('size').value);
  dirty = true;
  if (!img) { status('Nothing to export. Bring the skeleton into view first.', true); return; }
  const blob = await new Promise(r => toCanvas(img).toBlob(r, 'image/png'));
  await saveFile(`skeleton-${stamp()}-${img.w}x${img.h}.png`, blob);
}
function traceMask(img, hex) {
  // black where the mask is opaque, white elsewhere, then keep only the black shapes
  const n = img.w * img.h, d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { const v = img.data[i * 4 + 3] > 127 ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  const svg = ImageTracer.imagedataToSVG({ width: img.w, height: img.h, data: d }, {
    ltres: 0.15, qtres: 1.2, pathomit: 6, rightangleenhance: false, colorsampling: 0, numberofcolors: 2, mincolorratio: 0, colorquantcycles: 1,
    blurradius: 0, strokewidth: 0, linefilter: false, scale: 1, roundcoords: 1, viewbox: true, desc: false,
    pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
  });
  const paths = (svg.match(/<path[^>]*\/>/g) || []).filter(p => /fill="rgb\(0,0,0\)"/.test(p))
    .map(p => '<path d="' + (p.match(/ d="([^"]*)"/) || [0, ''])[1] + '"/>');
  return `<g fill="${hex}" fill-rule="evenodd">${paths.join('')}</g>`;
}
async function exportSVG() {
  status('Rendering and tracing. This takes a few seconds…');
  await new Promise(r => setTimeout(r, 30));
  const size = Math.min(+$("size").value, 4800);
  const inkImg = ink.renderCrop(size, { fillOn: 0 });
  if (!inkImg) { status('Nothing to export. Bring the skeleton into view first.', true); return; }
  let body = '';
  if ($('fillOn').checked) {
    const fillImg = ink.renderCrop(size, { fillOn: 1, inkOn: 0 });
    body += traceMask(fillImg, $('fillCol').value).replace('<g ', '<g id="bone-fill" ');
  }
  body += traceMask(inkImg, $('inkCol').value).replace('<g ', '<g id="ink" ');
  dirty = true;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${inkImg.w} ${inkImg.h}" width="${inkImg.w}" height="${inkImg.h}">${body}</svg>`;
  await saveFile(`skeleton-${stamp()}.svg`, new Blob([svg], { type: 'image/svg+xml' }));
}
$('png').addEventListener('click', () => exportPNG().catch(e => status('Export failed: ' + e.message, true)));
$('svg').addEventListener('click', () => exportSVG().catch(e => status('Export failed: ' + e.message, true)));

// ---------- start ----------
resize();
setView('front');
applyPreset(PRESETS[1]);
pushHistory();
drawSaved();
frame();

// hooks for automated checks
window.__app = { applyPreset: i => { applyPreset(PRESETS[i]); }, setView, ink, toCanvas, traceMask, presets: PRESETS, select: n => select(handles.find(h => h.name === n) || null), render: () => { dirty = true; } };
