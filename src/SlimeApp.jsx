import { useCallback, useEffect, useRef, useState } from 'react'

const COLORS = ['#f25ca5', '#9c72ef', '#4abaf4', '#69ce83', '#f6d94c', '#ff9a52']
const POINTS = 28
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const makeSlime = (width, height) => ({
  x: width / 2, y: height * .56, vx: 0, vy: 0,
  base: Math.min(width * .24, height * .23, 210),
  // `shape` is the slime's editable outline. Unlike a bounce ripple, it remains until reshaped.
  shape: Array.from({ length: POINTS }, () => 0),
  wobble: Array.from({ length: POINTS }, () => 0),
  wobbleVelocity: Array.from({ length: POINTS }, () => 0), color: COLORS[0],
})

export default function SlimeApp() {
  const canvasRef = useRef(null), slime = useRef(null), bounds = useRef({ width: 0, height: 0, floor: 0 }), pointer = useRef(null)
  const [gravity, setGravity] = useState(true), gravityRef = useRef(true)
  const [showHint, setShowHint] = useState(true)
  useEffect(() => { gravityRef.current = gravity }, [gravity])
  const reset = useCallback(() => { const { width, height } = bounds.current; if (width) slime.current = makeSlime(width, height) }, [])

  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas.getContext('2d'); let frame, last = performance.now()
    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect(), scale = Math.min(devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); ctx.setTransform(scale, 0, 0, scale, 0, 0)
      bounds.current = { width, height, floor: height - 92 }
      if (!slime.current) slime.current = makeSlime(width, height)
      else { slime.current.base = Math.min(width * .24, height * .23, 210); slime.current.x = clamp(slime.current.x, slime.current.base, width - slime.current.base) }
    }
    const skin = (s) => {
      const { width, floor } = bounds.current
      return Array.from({ length: POINTS }, (_, i) => {
        const angle = i / POINTS * Math.PI * 2, radius = Math.max(s.base * .46, s.base + s.shape[i] + s.wobble[i])
        return {
          x: clamp(s.x + Math.cos(angle) * radius, 0, width),
          y: Math.min(floor, s.y + Math.sin(angle) * radius),
        }
      })
    }
    const extent = (s, axis) => Math.max(...Array.from({ length: POINTS }, (_, i) => {
      const angle = i / POINTS * Math.PI * 2, r = Math.max(s.base * .46, s.base + s.shape[i] + s.wobble[i])
      return Math.abs(axis === 'x' ? Math.cos(angle) * r : Math.sin(angle) * r)
    }))
    const angleDistance = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
    const splat = (s, normal, force) => {
      for (let i = 0; i < POINTS; i++) {
        const angle = i / POINTS * Math.PI * 2, delta = angleDistance(angle, normal)
        const alongSurface = Math.abs(Math.sin(delta)), intoSurface = Math.max(0, Math.cos(delta))
        const target = force * (alongSurface * .78 - intoSurface * .48)
        s.shape[i] = clamp(s.shape[i] * .55 + target, -s.base * .38, s.base * .72)
      }
    }
    const drawBlob = (points, s) => {
      const path = new Path2D(), first = points[0], last = points.at(-1); path.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2)
      points.forEach((point, i) => { const next = points[(i + 1) % points.length]; path.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2) })
      ctx.save(); ctx.shadowColor = 'rgba(60,27,74,.25)'; ctx.shadowBlur = 28; ctx.shadowOffsetY = 21; ctx.fillStyle = s.color; ctx.fill(path); ctx.restore()
      const glow = ctx.createRadialGradient(s.x - s.base * .3, s.y - s.base * .42, s.base * .03, s.x, s.y, s.base * 1.15)
      glow.addColorStop(0, 'rgba(255,255,255,.92)'); glow.addColorStop(.13, 'rgba(255,255,255,.4)'); glow.addColorStop(.52, 'rgba(255,255,255,0)'); glow.addColorStop(1, 'rgba(73,15,95,.16)')
      ctx.fillStyle = glow; ctx.fill(path); ctx.save(); ctx.clip(path)
      ctx.fillStyle = 'rgba(255,255,255,.42)'; ctx.beginPath(); ctx.ellipse(s.x - s.base * .34, s.y - s.base * .36, s.base * .22, s.base * .09, -.55, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.ellipse(s.x - s.base * .03, s.y - s.base * .63, s.base * .075, s.base * .034, -.5, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(s.x + s.base * .42, s.y - s.base * .16, s.base * .05, 0, Math.PI * 2); ctx.fill(); ctx.restore()
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 2; ctx.stroke(path)
    }
    const draw = () => {
      const { width, height, floor } = bounds.current, bg = ctx.createLinearGradient(0, 0, width, height); bg.addColorStop(0, '#f7f0fb'); bg.addColorStop(.55, '#fdf2f7'); bg.addColorStop(1, '#fff7df'); ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height)
      const wash = ctx.createRadialGradient(width * .5, height * .38, 10, width * .5, height * .38, width * .65); wash.addColorStop(0, 'rgba(255,255,255,.7)'); wash.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = wash; ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = 'rgba(75,46,80,.1)'; ctx.fillRect(0, floor + 13, width, 1); if (slime.current) drawBlob(skin(slime.current), slime.current)
    }
    const tick = (now) => {
      const dt = Math.min(2, (now - last) / 16.67); last = now; const s = slime.current, { width, floor } = bounds.current
      if (s) {
        if (gravityRef.current) s.vy += .24 * dt
        const active = pointer.current
        if (active?.grabbed) {
          const dx = active.x - s.x, dy = active.y - s.y, distance = Math.hypot(dx, dy), angle = Math.atan2(dy, dx), index = Math.round((angle / (Math.PI * 2) + 1) * POINTS) % POINTS
          s.vx += dx * .011 * dt; s.vy += dy * .011 * dt
          // Sculpt a broad, smooth part of the perimeter instead of scaling the whole blob.
          const pull = clamp(distance - s.base * .58, -s.base * .24, s.base * .76)
          for (let i = 0; i < POINTS; i++) {
            const pointAngle = i / POINTS * Math.PI * 2, arc = Math.abs(angleDistance(pointAngle, angle))
            if (arc < 1.2) {
              const influence = Math.pow(Math.cos(arc / 1.2 * Math.PI / 2), 1.7)
              s.shape[i] = clamp(s.shape[i] + (pull * influence - s.shape[i]) * .22 * dt, -s.base * .4, s.base * .82)
            }
          }
          s.wobble[index] += Math.min(18, distance * .065) * dt; s.wobble[(index + 1) % POINTS] += 3 * dt; s.wobble[(index + POINTS - 1) % POINTS] += 3 * dt
        }
        s.vx *= .96; s.vy *= .96; s.x += s.vx * dt; s.y += s.vy * dt
        let halfHeight = extent(s, 'y')
        if (s.y + halfHeight > floor) {
          s.y = floor - halfHeight
          if (s.vy > 0) {
            splat(s, Math.PI / 2, clamp(s.vy * .2, s.base * .08, s.base * .5))
            s.vy = 0; s.vx *= .72; halfHeight = extent(s, 'y'); s.y = floor - halfHeight
          }
        }
        let halfWidth = extent(s, 'x')
        const wall = s.x - halfWidth < 0 ? -1 : s.x + halfWidth > width ? 1 : 0
        if (wall) {
          s.x = clamp(s.x, halfWidth, width - halfWidth)
          if (s.vx * wall > 0) {
            splat(s, wall < 0 ? Math.PI : 0, clamp(Math.abs(s.vx) * .2, s.base * .08, s.base * .5))
            s.vx = 0; s.vy *= .72; halfWidth = extent(s, 'x'); s.x = clamp(s.x, halfWidth, width - halfWidth)
          }
        }
        for (let i = 0; i < POINTS; i++) { const neighbors = (s.wobble[(i + 1) % POINTS] + s.wobble[(i + POINTS - 1) % POINTS]) * .5; s.wobbleVelocity[i] += ((neighbors - s.wobble[i]) * .26 - s.wobble[i] * .16) * dt; s.wobbleVelocity[i] *= .72; s.wobble[i] += s.wobbleVelocity[i] * dt }
      }
      draw(); frame = requestAnimationFrame(tick)
    }
    resize(); const observer = new ResizeObserver(resize); observer.observe(canvas); frame = requestAnimationFrame(tick); return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])
  const updatePointer = (event, down) => {
    const box = canvasRef.current.getBoundingClientRect(), s = slime.current, x = event.clientX - box.left, y = event.clientY - box.top
    const angle = s && Math.atan2(y - s.y, x - s.x), index = s && Math.round((angle / (Math.PI * 2) + 1) * POINTS) % POINTS
    const edge = s && Math.max(s.base * .46, s.base + s.shape[index] + s.wobble[index])
    const inside = s && Math.hypot(x - s.x, y - s.y) < edge
    pointer.current = { x, y, grabbed: down && (pointer.current?.grabbed || inside) }
    if (down && s && !inside) { s.wobbleVelocity[index] -= 16; s.vx += (x - s.x) * -.012; s.vy += (y - s.y) * -.012 }; if (down) setShowHint(false)
  }
  const chooseColor = (color) => { if (slime.current) slime.current.color = color; setShowHint(false) }
  return <main className="slime-app"><canvas ref={canvasRef} className="slime-canvas" aria-label="A large interactive blob of slime" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updatePointer(event, true) }} onPointerMove={(event) => pointer.current && updatePointer(event, true)} onPointerUp={() => { pointer.current = null }} onPointerCancel={() => { pointer.current = null }} /><section className="intro"><p className="eyebrow">SQUISH LAB</p><h1>goo blob</h1>{showHint && <p className="hint">grab an edge and sculpt it</p>}</section><nav className="control-bar" aria-label="Slime controls"><span className="label">color</span>{COLORS.map((color) => <button key={color} className="swatch" type="button" aria-label={`Make slime ${color}`} onClick={() => chooseColor(color)} style={{ '--swatch': color }} />)}<span className="divider" /><button className="text-button" type="button" onClick={() => setGravity((on) => !on)}>gravity {gravity ? 'on' : 'off'}</button><button className="text-button" type="button" onClick={reset}>reset</button></nav></main>
}
