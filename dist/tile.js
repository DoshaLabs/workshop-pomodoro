// Pomodoro: a workshop tile. The timer is kept as an end time in workshop.storage, so it keeps
// counting across reloads and restarts; workshop.notify says when a phase is over.

const ws = window.workshop
const body = document.getElementById('body')
const SVG = 'http://www.w3.org/2000/svg'

function el(tag, props = {}, ...kids) {
  const e = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') e.setAttribute('class', v)
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k in e && !(e instanceof SVGElement)) e[k] = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k)
  return e
}

const PHASES = { focus: 'Focus', short: 'Short break', long: 'Long break' }
const DEFAULTS = { focus: 25, short: 5, long: 15, every: 4, auto: false, sound: true }
const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD

function fresh() {
  return { phase: 'focus', running: false, endsAt: 0, left: null, cycle: 0, done: 0, day: today(), settings: { ...DEFAULTS } }
}

let s = { ...fresh(), ...((await ws.storage.get('state')) ?? {}) }
s.settings = { ...DEFAULTS, ...s.settings }
let editing = false

const duration = (p = s.phase) => Math.round(s.settings[p] * 60_000)
const remaining = () => (s.running ? Math.max(0, s.endsAt - Date.now()) : (s.left ?? duration()))

function fmt(ms) {
  const t = Math.ceil(ms / 1000)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

// In settings, typing in a field is not interrupted by a redraw.
async function save(redraw = !editing) {
  if (redraw) render()
  await ws.storage.set('state', s)
}

ws.storage.watch('state', (v) => {
  if (!v) return
  s = { ...fresh(), ...v, settings: { ...DEFAULTS, ...v.settings } }
  if (!editing) render()
})

// --- actions ---------------------------------------------------------------------------------

function start() {
  unlockAudio()
  s.endsAt = Date.now() + remaining()
  s.running = true
  s.left = null
  save()
}
function pause() {
  s.left = remaining()
  s.running = false
  save()
}
function reset() {
  s.running = false
  s.left = null
  save()
}
function choose(phase) {
  s.phase = phase
  s.running = false
  s.left = null
  save()
}

function advance(completed) {
  rollDay()
  const was = s.phase
  if (was === 'focus') {
    if (completed) {
      s.done += 1
      s.cycle += 1
    }
    s.phase = completed && s.cycle >= s.settings.every ? 'long' : 'short'
  } else {
    if (was === 'long') s.cycle = 0
    s.phase = 'focus'
  }
  s.left = null
  s.running = completed && s.settings.auto
  if (s.running) s.endsAt = Date.now() + duration()
  if (completed) {
    const text =
      was === 'focus'
        ? `Focus done (${s.done} today). Time for a ${s.phase === 'long' ? 'long' : 'short'} break.`
        : 'Break over. Back to focus.'
    ws.notify({ text }).catch(() => {})
    if (s.settings.sound) chime()
  }
  save()
}

function rollDay() {
  if (s.day !== today()) {
    s.day = today()
    s.done = 0
  }
}

// --- sound: a soft three-note chime made in the page, nothing fetched -------------------------

let audio = null
function unlockAudio() {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') audio.resume()
  } catch {}
}
function chime() {
  try {
    unlockAudio()
    const t0 = audio.currentTime
    ;[659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = audio.createOscillator()
      const g = audio.createGain()
      o.type = 'sine'
      o.frequency.value = f
      const t = t0 + i * 0.18
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.18, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
      o.connect(g).connect(audio.destination)
      o.start(t)
      o.stop(t + 1)
    })
  } catch {}
}

// --- view ------------------------------------------------------------------------------------

const R = 52
const C = 2 * Math.PI * R
let ring, timeEl, headBadge = null

function render() {
  rollDay()
  body.replaceChildren(editing ? settingsView() : timerView())
  tick()
}

function timerView() {
  ring = el('svg:circle', { class: 'arc', cx: 60, cy: 60, r: R, 'stroke-dasharray': C.toFixed(2) })
  timeEl = el('div', { class: 'time' })
  const every = s.settings.every
  return el(
    'div',
    { class: `timer phase-${s.phase}${s.running ? ' running' : ''}` },
    el(
      'div',
      { class: 'dial' },
      el('svg:svg', { viewBox: '0 0 120 120', class: 'ring' }, el('svg:circle', { class: 'track', cx: 60, cy: 60, r: R }), ring),
      el('div', { class: 'face' }, timeEl, el('div', { class: 'label' }, PHASES[s.phase]))
    ),
    el(
      'div',
      { class: 'side' },
      el(
        'div',
        { class: 'tabs', role: 'tablist' },
        Object.entries({ focus: 'Focus', short: 'Short', long: 'Long' }).map(([p, name]) =>
          el('button', { class: p === s.phase ? 'tab on' : 'tab', role: 'tab', 'aria-selected': String(p === s.phase), onclick: () => choose(p) }, name)
        )
      ),
      el(
        'div',
        { class: 'controls' },
        el('button', { class: 'primary', onclick: () => (s.running ? pause() : start()) }, s.running ? 'Pause' : s.left != null ? 'Resume' : 'Start'),
        el('button', { title: 'Reset this phase', onclick: reset }, 'Reset'),
        el('button', { title: 'Skip to the next phase', onclick: () => advance(false) }, 'Skip')
      ),
      el(
        'div',
        { class: 'stats' },
        el(
          'span',
          { class: 'dots', title: `${s.cycle} of ${every} before a long break` },
          Array.from({ length: every }, (_, i) => el('span', { class: i < s.cycle ? 'dot full' : 'dot' }))
        ),
        el('span', { class: 'muted' }, `${s.done} today`),
        el('button', { class: 'gear', title: 'Settings', 'aria-label': 'Settings', onclick: () => ((editing = true), render()) }, '⚙')
      )
    )
  )
}

function settingsView() {
  const num = (key, label, min, max) =>
    el(
      'label',
      { class: 'field' },
      el('span', {}, label),
      el('input', {
        type: 'number',
        min,
        max,
        step: 1,
        value: s.settings[key],
        onchange: (e) => {
          const n = Math.min(max, Math.max(min, Math.round(Number(e.target.value)) || DEFAULTS[key]))
          e.target.value = n
          s.settings[key] = n
          if (key === 'every') s.cycle = Math.min(s.cycle, n)
          save()
        }
      })
    )
  const check = (key, label) =>
    el(
      'label',
      { class: 'check' },
      el('input', { type: 'checkbox', checked: s.settings[key], onchange: (e) => ((s.settings[key] = e.target.checked), save()) }),
      label
    )
  return el(
    'div',
    { class: 'settings' },
    el(
      'div',
      { class: 'grid' },
      num('focus', 'Focus (min)', 1, 180),
      num('short', 'Short break', 1, 60),
      num('long', 'Long break', 1, 120),
      num('every', 'Long after', 1, 12)
    ),
    el(
      'div',
      { class: 'row' },
      check('auto', 'Start next phase on its own'),
      check('sound', 'Chime'),
      el('button', { class: 'primary', onclick: () => ((editing = false), render()) }, 'Done')
    ),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'link', onclick: () => ((s.done = 0), (s.cycle = 0), save()) }, 'Clear today’s count'),
      el('button', { class: 'link', onclick: () => ((s.settings = { ...DEFAULTS }), save(true)) }, 'Defaults')
    )
  )
}

function tick() {
  if (s.running && Date.now() >= s.endsAt) return advance(true)
  const left = remaining()
  if (timeEl) timeEl.textContent = fmt(left)
  if (ring) ring.setAttribute('stroke-dashoffset', (C * (1 - left / duration())).toFixed(2))
  const badge = s.running ? fmt(left) : s.left != null ? `⏸ ${fmt(left)}` : ''
  if (badge !== headBadge) {
    headBadge = badge
    ws.head.set({ title: `Pomodoro · ${PHASES[s.phase]}`, badge }).catch(() => {})
  }
}

document.addEventListener('keydown', (e) => {
  if (editing || e.target.closest?.('input, button')) return
  if (e.key === ' ') {
    e.preventDefault()
    s.running ? pause() : start()
  }
})

render()
setInterval(tick, 250)
