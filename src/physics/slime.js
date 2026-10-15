/**
 * Slime soft-body physics.
 *
 * Model: 2D particle ring (nodes 0..N-1, CCW) + center node N, solved with XPBD
 * (extended position-based dynamics) on a Verlet-style state (x, previous x), using many substeps with one solver iteration each
 * ("Small Steps in Physics Simulation", Macklin et al. 2019).
 *
 * Units are SI (m, kg, s, N). +y is up. Compliance α = 1 / stiffness (m/N); must be > 0.
 *
 * Properties and the mechanism behind each:
 *   stretchy   - soft distance springs + area (volume) constraint, no breaking
 *   malleable  - Maxwell/Bingham plastic flow of spring rest lengths above a yield strain,
 *                plus slow creep of rest lengths back to the original shape
 *   bouncy     - per-surface restitution in the PBD velocity pass, per node and for the
 *                center of mass (PBD contact projection is otherwise strongly dissipative)
 *   splat      - impact above a speed threshold applies an area-preserving plastic
 *                flatten (det F = 1) to every rest length and redirects normal momentum
 *                into tangential spread
 *   sticky     - contact nodes latch to an anchor through a compliant bond; the bond's XPBD
 *                force is measured and the bond breaks when its normal or shear part exceeds a limit
 */

export const DEFAULTS = {
  gravity: [0, -9.81],
  substeps: 12,
  maxDt: 1 / 30,
  nodes: 32,
  radius: 0.5,
  mass: 2,
  nodeRadius: 0.02,
  compliance: { edge: 1.5e-3, bend: 2e-2, radial: 8e-3, area: 1e-6 },
  grabCompliance: 1e-3,
  bondCompliance: 2e-3,
  damping: 4,
  bounce: { minSpeed: 0.5, window: 0.3 },
  airDrag: 0.05,
  plastic: { yield: 0.03, flow: 3, recover: 0.25, min: 0.2, max: 6 },
  splat: { speed: 6, fullSpeed: 14, maxFlatten: 0.75, spread: 0.5, duration: 0.15 },
  loadSmoothing: 0.01,
  restick: 0.15,
}

export const MATERIALS = {
  bouncy: { restitution: 0.92, friction: 0.15, adhesion: null },
  sticky: { restitution: 0.1, friction: 0.9, adhesion: { normal: 20, shear: 30, capture: 1 } },
}

const EPS = 1e-9

const merge = (base, over = {}) => Object.fromEntries(Object.entries(base).map(([k, v]) =>
  [k, !(k in over) ? v : v && typeof v === 'object' && !Array.isArray(v) ? { ...v, ...over[k] } : over[k]]))

/**
 * Half-plane surface. Free space is n·x ≥ offset.
 * @param {number} nx @param {number} ny outward normal (any length)
 * @param {number} offset plane offset along the unnormalized normal
 * @param {{restitution:number, friction:number, adhesion:?{normal:number, shear:number, capture:number}}} material
 *   adhesion.normal / adhesion.shear: peel force per node (N);
 *   adhesion.capture: max rebound speed e·|v_n| the bond can catch (m/s)
 */
export const surface = (nx, ny, offset, material) => {
  const l = Math.hypot(nx, ny)
  return { normal: [nx / l, ny / l], offset: offset / l, ...material }
}

const particle = (x, y, w) => ({
  x, y, px: x, py: y, vx: 0, vy: 0, fx: 0, fy: 0, w,
  vn: 0, contact: null, anchor: null, cooldown: 0,
})

/**
 * @typedef {{i:number, j:number, rest0:number, rest:number, compliance:number}} Spring
 *   rest0 is the original length; rest is the current plastic rest length.
 */

/** Builds a slime: ring nodes 0..N-1 (CCW), center node N, edge/bend/radial springs, area constraint. */
export function createSlime(cx, cy, options) {
  const o = merge(DEFAULTS, options), N = o.nodes, w = (N + 1) / o.mass
  const particles = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2
    return particle(cx + Math.cos(a) * o.radius, cy + Math.sin(a) * o.radius, w)
  })
  particles.push(particle(cx, cy, w))
  const springs = []
  const link = (i, j, compliance) => {
    const rest = Math.hypot(particles[j].x - particles[i].x, particles[j].y - particles[i].y)
    springs.push({ i, j, rest0: rest, rest, compliance })
  }
  for (let i = 0; i < N; i++) {
    link(i, (i + 1) % N, o.compliance.edge)
    link(i, (i + 2) % N, o.compliance.bend)
    link(i, N, o.compliance.radial)
  }
  const body = { o, particles, springs, area0: 0, grad: new Float64Array(2 * N), grab: null, splat: null, bounce: null }
  body.area0 = area(body)
  return body
}

/** Advances the body by dt seconds against a list of half-plane surfaces. */
export function step(body, surfaces, dt) {
  dt = Math.min(dt, body.o.maxDt)
  const h = dt / body.o.substeps
  for (let k = 0; k < body.o.substeps; k++) substep(body, surfaces, h)
  plasticFlow(body, dt)
  for (const p of body.particles) p.fx = p.fy = 0
}

/** Adds an external force (N) to node i for the next step. */
export function applyForce(body, i, fx, fy) {
  body.particles[i].fx += fx
  body.particles[i].fy += fy
}

/** Drags node i toward (x, y) with a compliant spring; pass i = null to release. */
export function setGrab(body, i, x, y) {
  body.grab = i == null ? null : { i, x, y }
}

export function nearestNode(body, x, y) {
  let best = 0, bestD = Infinity
  body.particles.forEach((p, i) => {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2
    if (d < bestD) { bestD = d; best = i }
  })
  return best
}

export function centerOfMass(body) {
  let x = 0, y = 0, vx = 0, vy = 0, m = 0
  for (const p of body.particles) {
    const pm = 1 / p.w
    x += p.x * pm; y += p.y * pm; vx += p.vx * pm; vy += p.vy * pm; m += pm
  }
  return { x: x / m, y: y / m, vx: vx / m, vy: vy / m }
}

/** Signed polygon area of the ring (shoelace formula). Positive for CCW. */
export function area(body) {
  const { particles: P } = body, N = body.o.nodes
  let A = 0
  for (let k = 0; k < N; k++) {
    const a = P[k], b = P[(k + 1) % N]
    A += a.x * b.y - b.x * a.y
  }
  return A / 2
}

function substep(body, surfaces, h) {
  const { o, particles: P } = body, [gx, gy] = o.gravity, drag = 1 / (1 + o.airDrag * h)

  // Predict: symplectic Euler on velocity, then x* = x + v·h. Air drag is implicit (stable for any h).
  for (const p of P) {
    p.vx = (p.vx + (gx + p.fx * p.w) * h) * drag
    p.vy = (p.vy + (gy + p.fy * p.w) * h) * drag
    p.px = p.x; p.py = p.y
    p.x += p.vx * h; p.y += p.vy * h
  }

  for (const s of body.springs) solveSpring(P, s, h)
  solveArea(body, h)
  if (body.grab) solvePoint(P[body.grab.i], body.grab.x, body.grab.y, o.grabCompliance, h)
  collide(body, surfaces, h)
  adhere(body, h)

  // Verlet velocity: v = (x - x_prev) / h.
  for (const p of P) { p.vx = (p.x - p.px) / h; p.vy = (p.y - p.py) / h }

  dampSprings(body, h)
  respond(body, h)

  if (body.splat && (body.splat.t -= h) <= 0) body.splat = null
}

/**
 * XPBD distance constraint C = |xj - xi| - rest.
 * Δλ = -C / (wi + wj + α/h²);  Δxi = -wi·Δλ·n,  Δxj = +wj·Δλ·n,  n = (xj - xi)/|xj - xi|.
 * One iteration per substep, so λ starts at 0 and needs no storage.
 */
function solveSpring(P, s, h) {
  const a = P[s.i], b = P[s.j], W = a.w + b.w
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
  if (!W || L < EPS) return
  const dl = -(L - s.rest) / (W + s.compliance / (h * h)) / L
  a.x -= a.w * dl * dx; a.y -= a.w * dl * dy
  b.x += b.w * dl * dx; b.y += b.w * dl * dy
}

/**
 * XPBD area (2D volume) constraint C = A - A0.
 * ∇_i A = ½ (y_{i+1} - y_{i-1},  x_{i-1} - x_{i+1}).
 * Keeps the slime incompressible: stretching thins it, splatting widens it.
 */
function solveArea(body, h) {
  const { particles: P, grad: g } = body, N = body.o.nodes
  let W = 0
  for (let k = 0; k < N; k++) {
    const prev = P[(k + N - 1) % N], next = P[(k + 1) % N], p = P[k]
    g[2 * k] = 0.5 * (next.y - prev.y)
    g[2 * k + 1] = 0.5 * (prev.x - next.x)
    W += p.w * (g[2 * k] ** 2 + g[2 * k + 1] ** 2)
  }
  if (W < EPS) return
  const dl = -(area(body) - body.area0) / (W + body.o.compliance.area / (h * h))
  for (let k = 0; k < N; k++) {
    const p = P[k]
    p.x += p.w * dl * g[2 * k]; p.y += p.w * dl * g[2 * k + 1]
  }
}

/** XPBD point constraint C = |x - t|:  Δx = (t - x)·w / (w + α/h²). */
function solvePoint(p, tx, ty, compliance, h) {
  if (!p.w) return
  const k = p.w / (p.w + compliance / (h * h))
  p.x += (tx - p.x) * k; p.y += (ty - p.y) * k
}

/**
 * Half-plane contact. Penetration d = offset + r - n·x.
 * Position: x += n·d. Friction (positional Coulomb): tangential slip this substep is
 * cancelled up to μ·d (static), else reduced by μ·d (kinetic).
 * Stores the pre-solve normal velocity vn for restitution in the velocity pass.
 */
function collide(body, surfaces, h) {
  const { particles: P, o } = body
  for (const p of P) {
    let touching = null
    for (const S of surfaces) {
      const [nx, ny] = S.normal, depth = S.offset + o.nodeRadius - (nx * p.x + ny * p.y)
      if (depth <= 0) continue
      if (!p.contact && !body.splat) impact(body, S, h)
      touching = S
      p.vn = p.vx * nx + p.vy * ny
      p.x += nx * depth; p.y += ny * depth
      const tx = -ny, ty = nx, slip = (p.x - p.px) * tx + (p.y - p.py) * ty, limit = S.friction * depth
      const cut = Math.abs(slip) <= limit ? slip : Math.sign(slip) * limit
      p.x -= tx * cut; p.y -= ty * cut
    }
    p.contact = touching
  }
}

/**
 * Classifies a new contact by the center-of-mass approach speed u = -v_c·n:
 *   u ≥ splat.speed     → splat (plastic, inelastic, sticks on adhesive surfaces)
 *   u > bounce.minSpeed → bounce (center-of-mass restitution at maximum compression)
 *   else                → resting contact
 */
function impact(body, S, h) {
  const c = centerOfMass(body), u = -(c.vx * S.normal[0] + c.vy * S.normal[1])
  if (u >= body.o.splat.speed) splat(body, S, c, u, h)
  else if (u > body.o.bounce.minSpeed && !body.bounce) body.bounce = { surface: S, speed: u, t: body.o.bounce.window }
}

/**
 * Plastic splat deformation.
 * Severity k ∈ [0,1] ramps from splat.speed to splat.fullSpeed. The rest shape is mapped by
 *   F = a·n⊗n + (1/a)·t⊗t,  a = 1 - maxFlatten·k,  det F = 1 (area preserved).
 * A spring with unit direction d and c = (d·n)² gets rest' = rest·|F d| = rest·√(a²c + (1-c)/a²):
 * springs along n shorten, springs along t lengthen. Plastic recovery later re-rounds the slime.
 * The collision is perfectly inelastic along n: the center-of-mass normal velocity is removed and
 * redirected into a tangential velocity field v_t ∝ impact·(r·t)/R (spread outward from the center).
 * Velocity changes are injected as position offsets Δx = Δv·h so the PBD velocity pass sees them.
 */
function splat(body, S, c, impact, h) {
  const { o, particles: P } = body, cfg = o.splat, [nx, ny] = S.normal, tx = -ny, ty = nx
  const k = Math.min(1, (impact - cfg.speed) / (cfg.fullSpeed - cfg.speed))
  const a = 1 - cfg.maxFlatten * k
  for (const s of body.springs) {
    const A = P[s.i], B = P[s.j], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1
    const cn = ((dx * nx + dy * ny) / L) ** 2
    s.rest = clampRest(o, s, s.rest * Math.sqrt(a * a * cn + (1 - cn) / (a * a)))
  }
  for (const p of P) {
    const push = (cfg.spread * impact * k * ((p.x - c.x) * tx + (p.y - c.y) * ty)) / o.radius
    p.x += (tx * push + nx * impact) * h; p.y += (ty * push + ny * impact) * h
  }
  body.splat = { surface: S, t: cfg.duration }
}

/**
 * Adhesion. Each anchored node is held by a compliant XPBD bond C = |x - a|, compliance α_b.
 * After the solve, the XPBD constraint force is exactly F = (x - a)/α_b, split into
 *   pull  = F·n        (tension away from the surface)
 *   shear = |F × n|
 * Loads are low-pass filtered (time constant loadSmoothing) to remove single-substep spikes.
 * The bond breaks when pull > adhesion.normal or shear > adhesion.shear (not during a splat,
 * whose impact transient would tear every fresh bond). Edge nodes of a
 * stuck patch carry the most load, so peeling propagates from the edge inward.
 */
function adhere(body, h) {
  const { o, particles: P } = body, kf = h / (h + o.loadSmoothing)
  for (const p of P) {
    const A = p.anchor
    if (!A) continue
    solvePoint(p, A.x, A.y, o.bondCompliance, h)
    const fx = (p.x - A.x) / o.bondCompliance, fy = (p.y - A.y) / o.bondCompliance, [nx, ny] = A.surface.normal
    A.pull += (fx * nx + fy * ny - A.pull) * kf
    A.shear += (Math.abs(fx * ny - fy * nx) - A.shear) * kf
    const limit = A.surface.adhesion
    if (!body.splat && (A.pull > limit.normal || A.shear > limit.shear)) { p.anchor = null; p.cooldown = o.restick }
  }
}

/**
 * Viscous dashpot along each spring (velocity pass):
 *   v_rel = (vj - vi)·n,  Δv_rel = -min(1, c·h)·v_rel, split by inverse mass.
 */
function dampSprings(body, h) {
  const P = body.particles, k = Math.min(1, body.o.damping * h)
  for (const s of body.springs) {
    const a = P[s.i], b = P[s.j], W = a.w + b.w
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy)
    if (!W || L < EPS) continue
    const nx = dx / L, ny = dy / L, j = (((b.vx - a.vx) * nx + (b.vy - a.vy) * ny) * k) / W
    a.vx += a.w * j * nx; a.vy += a.w * j * ny
    b.vx -= b.w * j * nx; b.vy -= b.w * j * ny
  }
}

/**
 * Contact velocity response (Müller et al. PBD):
 *   v_n' = max(v_n, -e·v_n_pre)
 * e = 0 while splatting or when |v_n_pre| < 2|g|h (stops resting jitter); else e = restitution.
 * Then latch: a contact node on an adhesive surface sticks when the bond can catch its rebound
 * (e·|v_n_pre| ≤ adhesion.capture) or when the body is splatting on that surface.
 */
function respond(body, h) {
  const { o, particles: P } = body, rest = 2 * Math.hypot(...o.gravity) * h
  for (const p of P) {
    p.cooldown = Math.max(0, p.cooldown - h)
    if (p.anchor) continue
    const S = p.contact
    if (!S) continue
    const [nx, ny] = S.normal, vn = p.vx * nx + p.vy * ny, splatting = body.splat?.surface === S
    const e = splatting || -p.vn < rest ? 0 : S.restitution
    const dv = Math.max(0, -e * p.vn - vn)
    p.vx += nx * dv; p.vy += ny * dv
    if (S.adhesion && !p.cooldown && (splatting || -e * p.vn <= S.adhesion.capture))
      p.anchor = { x: p.x, y: p.y, surface: S, pull: 0, shear: 0 }
  }
  bounce(body, h)
}

/**
 * Center-of-mass restitution, applied at maximum compression (v_c·n turns positive):
 *   Δv = max(0, e·u - v_c·n), added along n to every free node,
 * where u is the approach speed stored at impact. Momentum-level, so internal wobble is kept.
 * Expires after bounce.window so a body that came to rest gets no late kick.
 */
function bounce(body, h) {
  const B = body.bounce
  if (!B) return
  if ((B.t -= h) <= 0) { body.bounce = null; return }
  const [nx, ny] = B.surface.normal, c = centerOfMass(body), vn = c.vx * nx + c.vy * ny
  if (vn <= 0) return
  const dv = Math.max(0, B.surface.restitution * B.speed - vn)
  for (const p of body.particles) if (!p.anchor) { p.vx += nx * dv; p.vy += ny * dv }
  body.bounce = null
}

/**
 * Viscoelastic-plastic rest-length update, once per frame (Maxwell element with yield):
 *   ε = (L - rest)/rest
 *   if |ε| > yield:  rest += (L - rest)·(1 - yield/|ε|)·min(1, flow·dt)   (flows to hold the new shape)
 *   rest += (rest0 - rest)·min(1, recover·dt)                            (slow return to rest state)
 * During a splat the flow is instant and recovery pauses: high strain rate yields fully, so the
 * impact energy is absorbed plastically instead of recoiling elastically.
 * rest is clamped to [min, max]·rest0, so the slime stretches far but never tears.
 */
function plasticFlow(body, dt) {
  const { o, particles: P } = body, { yield: y, flow, recover } = o.plastic
  const kf = body.splat ? 1 : Math.min(1, flow * dt), kr = body.splat ? 0 : Math.min(1, recover * dt)
  for (const s of body.springs) {
    const L = Math.hypot(P[s.j].x - P[s.i].x, P[s.j].y - P[s.i].y), e = Math.abs(L - s.rest) / s.rest
    if (e > y) s.rest += (L - s.rest) * (1 - y / e) * kf
    s.rest = clampRest(o, s, s.rest + (s.rest0 - s.rest) * kr)
  }
}

const clampRest = (o, s, v) => Math.min(s.rest0 * o.plastic.max, Math.max(s.rest0 * o.plastic.min, v))
