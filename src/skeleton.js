import * as THREE from 'three';

// Materials used for the data pass: bone surfaces write view normals, "fill" surfaces write pure black
// (eye sockets, nasal cavity) which the ink shader turns into solid ink.
export const boneMat = new THREE.MeshNormalMaterial();
export const boneMatDS = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
export const fillMat = new THREE.MeshBasicMaterial({ color: 0x000000 });

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const lerp = (a, b, t) => a + (b - a) * t;

function ball(parent, r, pos, scale, mat = boneMat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
  m.position.set(pos[0], pos[1], pos[2]);
  if (scale) m.scale.set(scale[0], scale[1], scale[2]);
  parent.add(m);
  return m;
}

// Swept tube along a smooth curve with a radius profile, rounded at both ends.
function sweep(parent, pts, rfn, opt = {}) {
  const seg = opt.seg || 20, rad = opt.rad || 10;
  const r = typeof rfn === 'number' ? () => rfn : rfn;
  const curve = new THREE.CatmullRomCurve3(pts.map(p => (p.isVector3 ? p : V(p[0], p[1], p[2]))));
  const frames = curve.computeFrenetFrames(seg, false);
  const pos = [], idx = [];
  const P = V(0, 0, 0);
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    curve.getPointAt(t, P);
    const rr = r(t);
    const N = frames.normals[i], B = frames.binormals[i];
    for (let j = 0; j < rad; j++) {
      const a = (j / rad) * Math.PI * 2, c = Math.cos(a) * rr, s = Math.sin(a) * rr;
      pos.push(P.x + N.x * c + B.x * s, P.y + N.y * c + B.y * s, P.z + N.z * c + B.z * s);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < rad; j++) {
    const j1 = (j + 1) % rad;
    const a = i * rad + j, b = i * rad + j1, c = (i + 1) * rad + j1, d = (i + 1) * rad + j;
    idx.push(a, b, d, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(g, opt.mat || boneMat));
  const p0 = curve.getPointAt(0), p1 = curve.getPointAt(1);
  if (!opt.noCaps) {
    ball(grp, r(0), [p0.x, p0.y, p0.z]);
    ball(grp, r(1), [p1.x, p1.y, p1.z]);
  }
  parent.add(grp);
  return grp;
}

// bump profile: thick at both ends, thin in the middle
const shaft = (r0, rm, r1) => t => {
  const e = Math.pow(Math.abs(2 * t - 1), 2.2);
  return lerp(rm, t < 0.5 ? r0 : r1, e);
};

export function buildSkeleton() {
  const root = new THREE.Group();
  root.position.set(0, 0.945, 0);
  const J = {};            // pose nodes by name (identity quaternion = rest pose)
  const chains = {};       // distributed spine chains
  const hands = { L: null, R: null };

  function joint(name, parent, pos, restX = 0) {
    const rest = new THREE.Group();
    rest.position.set(pos[0], pos[1], pos[2]);
    rest.rotation.x = restX;
    parent.add(rest);
    const pose = new THREE.Group();
    rest.add(pose);
    if (name) { J[name] = pose; pose.name = name; }
    return pose;
  }

  J.pelvis = root; root.name = 'pelvis';

  // ---------- pelvis ----------
  sweep(root, [[0, 0.05, -0.05], [0, -0.01, -0.068], [0, -0.07, -0.07]], t => lerp(0.034, 0.009, t)).scale.set(1.25, 1, 0.75);
  for (const s of [1, -1]) {
    const il = ball(root, 1, [s * 0.088, 0.03, -0.022], [0.07, 0.066, 0.015]);
    il.rotation.set(-0.25, -s * 0.75, -s * 0.3);
    // iliac crest rim
    sweep(root, [[s * 0.03, 0.055, -0.06], [s * 0.085, 0.095, -0.045], [s * 0.132, 0.075, 0.0], [s * 0.128, 0.02, 0.04]], 0.009, { rad: 8 });
    // pubis / ischium ring with the obturator opening
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.027, 0.0095, 10, 22), boneMat);
    ring.position.set(s * 0.047, -0.09, 0.03);
    ring.rotation.set(0.25, s * 0.45, 0);
    ring.scale.set(0.9, 1.15, 1);
    root.add(ring);
    sweep(root, [[s * 0.1, -0.04, 0.0], [s * 0.07, -0.058, 0.03], [s * 0.022, -0.075, 0.052]], 0.012, { rad: 8 });
    ball(root, 0.031, [s * 0.088, -0.07, 0.008]);
  }
  ball(root, 0.014, [0, -0.082, 0.052], [1, 1.5, 0.9]);

  // ---------- spine ----------
  function vertebra(node, h, r, wings = true) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.76, 14), boneMat);
    body.position.set(0, h * 0.5, 0);
    body.scale.z = 0.86;
    node.add(body);
    sweep(node, [[0, h * 0.55, -r * 0.7], [0, h * 0.2, -r * 2.3]], t => lerp(r * 0.36, r * 0.24, t), { seg: 4, rad: 6 });
    if (wings) sweep(node, [[-r * 1.75, h * 0.6, -r * 0.9], [0, h * 0.55, -r * 0.6], [r * 1.75, h * 0.6, -r * 0.9]], r * 0.27, { seg: 6, rad: 6 });
  }
  function chain(name, parent, basePos, baseTilt, n, h, rfn, stepTilt, posed) {
    const nodes = [];
    let p = parent, pos = basePos, tilt = baseTilt;
    for (let i = 0; i < n; i++) {
      const node = joint(null, p, pos, tilt);
      vertebra(node, h, rfn(i), name !== 'neck');
      nodes.push(node);
      p = node; pos = [0, h, 0]; tilt = stepTilt;
    }
    if (posed) {
      // proxy control: its quaternion is the total bend, spread evenly over the chain
      const proxyRest = new THREE.Group();
      proxyRest.position.set(basePos[0], basePos[1], basePos[2]);
      proxyRest.rotation.x = baseTilt;
      parent.add(proxyRest);
      const proxy = new THREE.Group();
      proxyRest.add(proxy);
      proxy.name = name;
      J[name] = proxy;
      chains[name] = { proxy, nodes };
    }
    return { end: p, h, nodes };
  }
  const d2r = Math.PI / 180;
  const lum = chain('lumbar', root, [0, 0.05, -0.05], 16 * d2r, 5, 0.036, i => 0.0245 - i * 0.0006, -6.5 * d2r, true);
  const chest = joint('chest', lum.end, [0, lum.h, 0], -6.5 * d2r);
  const tho = chain('thoracic', chest, [0, 0, 0], 0, 12, 0.0235, i => 0.0205 - i * 0.0004, 3.2 * d2r, false);
  const neck = chain('neck', tho.end, [0, tho.h, 0], -3 * d2r, 7, 0.0165, () => 0.0125, -4.2 * d2r, true);
  const head = joint('head', neck.end, [0, neck.h, 0], 7 * d2r);

  // ---------- rib cage (built in chest space) ----------
  root.updateMatrixWorld(true);
  const T = []; // T[1..12] centres in chest space, T1 is the top
  for (let i = 0; i < 12; i++) {
    const p = tho.nodes[i].getWorldPosition(V(0, 0, 0));
    chest.worldToLocal(p);
    T[12 - i] = p;
  }
  const sTop = V(0, T[1].y - 0.048, T[2].z + 0.118);
  const sBot = V(0, sTop.y - 0.15, T[8].z + 0.178);
  {
    const d = sBot.clone().sub(sTop), L = d.length();
    const st = new THREE.Mesh(new THREE.CapsuleGeometry(0.017, L - 0.02, 6, 14), boneMat);
    st.position.copy(sTop).addScaledVector(d, 0.5);
    st.rotation.x = Math.atan2(-d.z, -d.y);
    st.scale.set(1.1, 1, 0.42);
    chest.add(st);
    const man = ball(chest, 1, [sTop.x, sTop.y + 0.004, sTop.z], [0.03, 0.026, 0.009]);
    man.rotation.x = st.rotation.x;
    ball(chest, 0.006, [0, sBot.y - 0.02, sBot.z + 0.002], [1, 2.2, 0.7]);
  }
  const W = [0, 0.052, 0.08, 0.098, 0.11, 0.118, 0.122, 0.124, 0.121, 0.114, 0.104, 0.09, 0.074];
  const margin = { 1: [], '-1': [] };
  for (const s of [1, -1]) {
    for (let i = 1; i <= 12; i++) {
      const B = V(s * 0.02, T[i].y + 0.012, T[i].z - 0.008);
      let F, tEnd = 1;
      if (i <= 7) {
        F = sTop.clone().lerp(sBot, 0.03 + ((i - 1) / 6) * 0.94); F.x = s * 0.017;
      } else if (i <= 10) {
        const k = i - 7;
        F = V(s * (0.03 + k * 0.026), sBot.y - k * 0.032 + 0.004, sBot.z - k * 0.012);
        margin[s].push(F.clone());
      } else {
        F = V(s * 0.02, B.y - 0.11, B.z + 0.19);
        tEnd = i === 11 ? 0.5 : 0.36;
      }
      const pts = [];
      const n = 16;
      for (let k = 0; k <= n; k++) {
        const t = (k / n) * tEnd;
        const x = s * (lerp(0.02, Math.abs(F.x), t) + W[i] * Math.pow(Math.sin(Math.PI * t), 0.82));
        const y = lerp(B.y, F.y, Math.pow(t, 1.25)) - (0.014 + 0.0046 * Math.min(i, 8)) * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.12)), 1.3);
        const z = lerp(B.z, F.z, (1 - Math.cos(Math.PI * t)) / 2) - 0.02 * Math.exp(-Math.pow((t - 0.14) / 0.11, 2));
        pts.push(V(x, y, z));
      }
      sweep(chest, pts, 0.0054, { seg: 30, rad: 7 });
    }
    const f7 = sTop.clone().lerp(sBot, 0.97); f7.x = s * 0.02;
    const m = margin[s];
    sweep(chest, [m[2], m[1], m[0], f7], 0.005, { seg: 12, rad: 7 });
  }

  // ---------- skull ----------
  ball(head, 1, [0, 0.1, 0.006], [0.077, 0.082, 0.095]);                  // cranium
  ball(head, 1, [0, 0.052, 0.06], [0.05, 0.05, 0.041]);                    // face
  ball(head, 1, [0, 0.012, 0.064], [0.037, 0.022, 0.035]);                 // maxilla
  sweep(head, [[-0.05, 0.088, 0.078], [-0.028, 0.096, 0.094], [0, 0.089, 0.098], [0.028, 0.096, 0.094], [0.05, 0.088, 0.078]], 0.0045, { rad: 8 });
  for (const s of [1, -1]) {
    ball(head, 1, [s * 0.046, 0.045, 0.064], [0.017, 0.013, 0.02]);        // cheekbone
    sweep(head, [[s * 0.054, 0.046, 0.058], [s * 0.066, 0.045, 0.03], [s * 0.066, 0.048, 0.0]], 0.005, { rad: 6, seg: 8 });
    ball(head, 1, [s * 0.029, 0.067, 0.091], [0.0225, 0.021, 0.013], fillMat); // eye socket
    ball(head, 1, [s * 0.006, 0.032, 0.0985], [0.008, 0.011, 0.006], fillMat); // nasal cavity lower
  }
  ball(head, 1, [0, 0.042, 0.098], [0.006, 0.013, 0.006], fillMat);
  const toothRow = (parent, y, zc, rx, rz, hgt) => {
    const n = 12;
    for (let k = 0; k < n; k++) {
      const a = lerp(-1.2, 1.2, k / (n - 1));
      const w = Math.abs(a) < 0.3 ? 0.0082 : 0.0074;
      const t = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, 0.006), boneMat);
      t.position.set(Math.sin(a) * rx, y, zc + Math.cos(a) * rz);
      t.rotation.y = a;
      parent.add(t);
    }
  };
  toothRow(head, -0.012, 0.064, 0.032, 0.033, 0.013);
  const jaw = joint('jaw', head, [0, 0.03, 0.012]);
  sweep(jaw, [[0.053, 0.006, 0], [0.052, -0.03, 0.0], [0.049, -0.058, 0.008], [0.04, -0.07, 0.032], [0.024, -0.074, 0.064], [0, -0.075, 0.079],
    [-0.024, -0.074, 0.064], [-0.04, -0.07, 0.032], [-0.049, -0.058, 0.008], [-0.052, -0.03, 0.0], [-0.053, 0.006, 0]],
    t => 0.008 + 0.004 * Math.pow(Math.sin(Math.PI * t), 4), { seg: 40, rad: 8 });
  ball(jaw, 1, [0, -0.07, 0.074], [0.018, 0.013, 0.011]);
  toothRow(jaw, -0.056, 0.053, 0.029, 0.03, 0.011);

  // ---------- limbs ----------
  for (const s of [1, -1]) {
    const S = s === 1 ? 'L' : 'R';
    // shoulder girdle
    const clav = joint('clavicle' + S, chest, [s * 0.022, sTop.y + 0.012, sTop.z - 0.004]);
    const sh = [s * 0.158, -0.01, sTop.z * 0 - 0.082]; // glenohumeral joint, relative to clavicle root
    sweep(clav, [[0, 0, 0], [s * 0.055, 0.01, 0.006], [s * 0.11, 0.02, -0.035], [s * 0.152, 0.024, -0.075]], shaft(0.0095, 0.0068, 0.008), { rad: 8 });
    {
      // scapula: thin triangular plate with a ridge
      const a = V(s * 0.155, 0.02, -0.1), b = V(s * 0.062, 0.005, -0.142), c = V(s * 0.09, -0.15, -0.148);
      const nrm = b.clone().sub(a).cross(c.clone().sub(a)).normalize().multiplyScalar(0.004);
      const vs = [a, b, c].flatMap(p => [p.clone().add(nrm), p.clone().sub(nrm)]);
      const g = new THREE.BufferGeometry();
      const tri = [0, 2, 4, 1, 5, 3, 0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 1, 4, 1, 0];
      g.setAttribute('position', new THREE.Float32BufferAttribute(tri.flatMap(i => vs[i].toArray()), 3));
      g.computeVertexNormals();
      clav.add(new THREE.Mesh(g, boneMatDS));
      sweep(clav, [[s * 0.07, -0.02, -0.146], [s * 0.12, 0.005, -0.125], [s * 0.16, 0.026, -0.085]], 0.0065, { rad: 6, seg: 8 });
      sweep(clav, [a, b, c, a], 0.0045, { rad: 6, seg: 24 });
    }
    // arm
    const shoulder = joint('shoulder' + S, clav, sh);
    ball(shoulder, 0.0235, [-s * 0.006, 0.0, 0]);
    sweep(shoulder, [[s * 0.006, -0.006, 0], [s * 0.004, -0.14, 0.002], [0, -0.296, 0]], shaft(0.0185, 0.0105, 0.013), { seg: 22 });
    ball(shoulder, 0.0135, [s * 0.017, -0.298, 0.002], [1, 0.95, 1.1]);
    ball(shoulder, 0.0135, [-s * 0.017, -0.298, 0.002], [1.1, 0.95, 1.1]);
    const elbow = joint('elbow' + S, shoulder, [0, -0.3, 0]);
    sweep(elbow, [[-s * 0.004, 0.016, -0.014], [-s * 0.004, -0.03, -0.01], [-s * 0.002, -0.14, -0.012], [0, -0.25, -0.011]], t => lerp(0.0125, 0.0058, Math.pow(t, 0.6)), { seg: 18 }); // ulna
    sweep(elbow, [[s * 0.012, -0.012, 0.006], [s * 0.012, -0.11, 0.013], [s * 0.003, -0.248, 0.011]], t => lerp(0.0075, 0.0115, Math.pow(t, 2.2)), { seg: 18 });   // radius
    const wrist = joint('wrist' + S, elbow, [0, -0.255, 0]);
    // hand: palm lies in the Y/Z plane, thumb toward +Z, palm faces the body
    ball(wrist, 1, [0, -0.014, 0.001], [0.0115, 0.0155, 0.026]);
    const H = { curlNodes: [], spreadNodes: [], thumb: [], side: s };
    const zb = [0.018, 0.006, -0.006, -0.017], zh = [0.03, 0.0105, -0.009, -0.0265];
    const Lm = [0.064, 0.062, 0.056, 0.051];
    const ph = [[0.04, 0.023, 0.018], [0.045, 0.027, 0.019], [0.041, 0.025, 0.018], [0.033, 0.019, 0.016]];
    for (let k = 0; k < 4; k++) {
      sweep(wrist, [[0, -0.028, zb[k]], [0, -0.028 - Lm[k], zh[k]]], shaft(0.0055, 0.0042, 0.006), { seg: 6, rad: 7 });
      const base = joint(null, wrist, [0, -0.028 - Lm[k], zh[k]], -Math.atan2(zh[k] - zb[k], Lm[k]));
      const spreadNode = base;
      let p = joint(null, base, [0, 0, 0]);
      const curl = [];
      for (let q = 0; q < 3; q++) {
        sweep(p, [[0, 0, 0], [0, -ph[k][q], 0]], shaft(0.0052, 0.0038, 0.0046), { seg: 5, rad: 7 });
        curl.push(p);
        p = joint(null, p, [0, -ph[k][q], 0]);
      }
      H.curlNodes.push(curl);
      H.spreadNodes.push(spreadNode);
    }
    {
      const base = joint(null, wrist, [-s * 0.004, -0.02, 0.022], -0.85);
      let p = base; const tl = [0.044, 0.031, 0.025];
      for (let q = 0; q < 3; q++) {
        sweep(p, [[0, 0, 0], [0, -tl[q], 0]], shaft(0.0062, 0.0046, 0.0054), { seg: 5, rad: 7 });
        H.thumb.push(p);
        p = joint(null, p, [0, -tl[q], 0]);
      }
    }
    hands[S] = H;

    // leg
    const hip = joint('hip' + S, root, [s * 0.088, -0.07, 0.008]);
    ball(hip, 0.0245, [0, 0, 0]);
    sweep(hip, [[0, 0, 0], [s * 0.046, -0.014, -0.002]], 0.0135, { seg: 4, rad: 8 });
    ball(hip, 0.0195, [s * 0.054, -0.008, -0.006], [1, 1.25, 1]);
    sweep(hip, [[s * 0.05, -0.022, 0], [s * 0.032, -0.2, 0.012], [-s * 0.012, -0.4, 0]], shaft(0.0185, 0.0128, 0.02), { seg: 24 });
    ball(hip, 0.0265, [-s * 0.012 + 0.024, -0.415, -0.004], [0.95, 0.95, 1.2]);
    ball(hip, 0.0265, [-s * 0.012 - 0.024, -0.415, -0.004], [0.95, 0.95, 1.2]);
    ball(hip, 1, [-s * 0.012, -0.408, 0.04], [0.021, 0.023, 0.011]);     // patella
    const knee = joint('knee' + S, hip, [-s * 0.012, -0.42, 0]);
    ball(knee, 1, [0, -0.02, 0], [0.041, 0.014, 0.031]);
    sweep(knee, [[0, -0.02, 0], [0, -0.19, 0.005], [0, -0.38, 0]], t => lerp(0.024, 0.0125, Math.pow(Math.min(1, t * 2.2), 0.7)) + 0.004 * Math.pow(t, 6), { seg: 22 });
    ball(knee, 0.0125, [-s * 0.02, -0.386, 0.002], [1, 1.3, 1.1]);
    sweep(knee, [[s * 0.036, -0.035, -0.014], [s * 0.034, -0.2, -0.01], [s * 0.028, -0.392, -0.006]], shaft(0.0095, 0.0062, 0.0095), { seg: 18, rad: 8 });
    const ankle = joint('ankle' + S, knee, [0, -0.385, 0]);
    ball(ankle, 1, [0, -0.018, 0.006], [0.023, 0.018, 0.03]);
    ball(ankle, 1, [0, -0.047, -0.036], [0.022, 0.023, 0.04]);
    ball(ankle, 1, [0, -0.04, 0.045], [0.03, 0.017, 0.03]);
    const toes = joint('toes' + S, ankle, [0, -0.066, 0.135]);
    const tL = [0.05, 0.043, 0.038, 0.033, 0.027];
    for (let k = 0; k < 5; k++) {
      const xb = -s * 0.022 + s * k * 0.011, xh = -s * 0.03 + s * k * 0.0155;
      const zk = -0.006 * k;
      sweep(ankle, [[xb, -0.044, 0.064], [xh, -0.066, 0.135 + zk]], shaft(k ? 0.0058 : 0.0085, k ? 0.0042 : 0.0064, k ? 0.006 : 0.009), { seg: 6, rad: 7 });
      sweep(toes, [[xh, 0, zk], [xh * 1.02, -0.001, zk + tL[k] * 0.55], [xh * 1.03, -0.003, zk + tL[k]]], shaft(k ? 0.0054 : 0.0078, k ? 0.004 : 0.006, k ? 0.0046 : 0.007), { seg: 6, rad: 7 });
    }
  }

  root.traverse(o => { o.frustumCulled = false; });
  return { root, J, chains, hands };
}
