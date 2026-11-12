// Pomodoro: a workshop tile. The timer is kept as an end time in workshop.storage, so it keeps
// counting across reloads and restarts; workshop.notify says when a phase is over.
//
// storage 'state': the timer and settings.  storage 'log': one entry per finished focus block,
// { t: end time (ms), m: minutes, intent, project }, newest last.
//
// Opt-in (settings, both off by default):
//   - the door: Claude sessions can run `status`, `start`, `pause`, `skip`, `extend`.
//   - announce: when a phase ends, a line is typed into a Claude session (the one that last
//     started the timer through the door, one picked in settings, else the focused one).

const ws = window.workshop
const body = document.getElementById('body')
const SVG = 'http://www.w3.org/2000/svg'

function el(tag, props = {}, ...kids) {
  const e = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue
    if (k === 'class') e.setAttribute('class', v)
    else if (k === 'vars') for (const [n, x] of Object.entries(v)) e.style.setProperty(n, x)
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k in e && !(e instanceof SVGElement)) e[k] = v
    else e.setAttribute(k, v === true ? '' : v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k)
  return e
}

const PHASES = { focus: 'Focus', short: 'Short break', long: 'Long break' }
const DEFAULTS = {
  focus: 25, short: 5, long: 15, every: 4, goal: 8,
  auto: false, sound: true, ask: true, door: false, announce: false
}
const LOG_MAX = 5000
const DAY = 86_400_000
const dayOf = (t) => new Date(t).toLocaleDateString('en-CA') // YYYY-MM-DD
const today = () => dayOf(Date.now())
const base = (p) => (p ? p.replace(/\/+$/, '').split('/').pop() : null)

function fresh() {
  return { phase: 'focus', running: false, endsAt: 0, left: null, extra: 0, cycle: 0, intent: '', linked: null, settings: { ...DEFAULTS } }
}
function load(v) {
  const n = { ...fresh(), ...(v ?? {}) }
  n.settings = { ...DEFAULTS, ...n.settings }
  delete n.done
  delete n.day
  return n
}

const stored = await ws.storage.get('state')
let s = load(stored)
let log = (await ws.storage.get('log')) ?? []

// 0.1 kept only a count for today: carry it into the log once.
if (!log.length && stored?.done > 0 && stored.day === today()) {
  log = Array.from({ length: stored.done }, () => ({ t: Date.now(), m: s.settings.focus, intent: null, project: null }))
  ws.storage.set('log', log)
}

let editing = false // the settings view is showing
let stale = false //   a redraw is waiting for the user to leave a field

const duration = (p = s.phase) => Math.round(s.settings[p] * 60_000)
const total = () => duration() + s.extra * 60_000
const remaining = () => (s.running ? Math.max(0, s.endsAt - Date.now()) : (s.left ?? total()))
const doneOn = (d) => log.filter((e) => dayOf(e.t) === d)

function fmt(ms) {
  const t = Math.ceil(ms / 1000)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

// A redraw never pulls a field out from under the user's typing; it waits for them to leave it.
const typing = () => document.activeElement?.matches?.('input[type=text], input[type=number], select') ?? false
function redraw() {
  if (typing()) stale = true
  else render()
}
document.addEventListener('focusout', () =>
  setTimeout(() => {
    if (stale && !typing()) {
      stale = false
      render()
    }
  })
)

async function save() {
  redraw()
  await ws.storage.set('state', s)
}
async function saveLog() {
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX)
  redraw()
  await ws.storage.set('log', log)
}

ws.storage.watch('state', (v) => {
  if (!v) return
  s = load(v)
  redraw()
})
ws.storage.watch('log', (v) => {
  log = v ?? []
  redraw()
})
ws.onViewChange(() => render())

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
  s.extra = 0
  save()
}
function choose(phase) {
  s.phase = phase
  s.running = false
  s.left = null
  s.extra = 0
  save()
}
function extend(min = 5) {
  const ms = min * 60_000
  s.extra += min
  if (s.running) s.endsAt += ms
  else if (s.left != null) s.left += ms
  save()
}

async function advance(completed) {
  const was = s.phase
  const late = s.running ? Date.now() - s.endsAt : 0
  let entry = null
  if (was === 'focus') {
    if (completed) {
      s.cycle += 1
      entry = { t: Date.now(), m: Math.round(total() / 60_000), intent: s.intent.trim() || null, project: null }
      log.push(entry)
    }
    s.phase = completed && s.cycle >= s.settings.every ? 'long' : 'short'
  } else {
    if (was === 'long') s.cycle = 0
    s.phase = 'focus'
  }
  s.left = null
  s.extra = 0
  s.running = completed && s.settings.auto
  if (s.running) s.endsAt = Date.now() + duration()
  save()
  if (!completed) return

  const n = doneOn(today()).length
  const text =
    was === 'focus'
      ? `Focus done (${n} of ${s.settings.goal} today). Time for a ${s.phase === 'long' ? 'long' : 'short'} break.`
      : 'Break over. Back to focus.'
  ws.notify({ text }).catch(() => {})
  if (s.settings.sound) chime()

  const who = await target()
  if (entry) {
    entry.project = base(who?.root ?? who?.project)
    saveLog()
  }
  // A phase that ended while workshop was closed is old news: don't type it into a session.
  if (s.settings.announce && late < 120_000) announce(who, was)
}

// --- Claude sessions -------------------------------------------------------------------------

let sessions = []
async function listSessions() {
  try {
    sessions = (await ws.sessions.list()).filter((x) => x.open !== false && x.status !== 'dead')
  } catch {
    sessions = []
  }
  return sessions
}
// The session this timer belongs to: the linked one while it is open, else the focused one.
async function target() {
  const list = await listSessions()
  return list.find((x) => x.id === s.linked) ?? list.find((x) => x.focused) ?? null
}

function announce(who, was) {
  if (!who) return
  // A session waiting on a permission prompt would take the text as its answer.
  if (who.status === 'blocked' || who.status === 'starting') {
    ws.notify({ text: `Didn't tell ${who.name} about the ${PHASES[s.phase].toLowerCase()}: it is waiting on you.` }).catch(() => {})
    return
  }
  const what = s.intent.trim() ? ` (${s.intent.trim()})` : ''
  const text =
    was === 'focus'
      ? `[Pomodoro] Focus block done${what}. ${PHASES[s.phase]} of ${s.settings[s.phase]} min starts now: ` +
        `finish the step you are on, then stop and give me a two-line note of where things stand.`
      : `[Pomodoro] Break over. ${s.settings.focus} min of focus starts now${what}. Pick up where we left off.`
  ws.sessions.paste(who.id, text).catch((e) => ws.notify({ text: `Couldn't tell ${who.name}: ${e.message}` }).catch(() => {}))
}

function status() {
  const left = remaining()
  return {
    phase: s.phase,
    running: s.running,
    paused: !s.running && s.left != null,
    remaining: fmt(left),
    remainingSec: Math.ceil(left / 1000),
    intent: s.intent || null,
    today: doneOn(today()).length,
    goal: s.settings.goal,
    untilLongBreak: Math.max(0, s.settings.every - s.cycle),
    announcing: s.settings.announce
  }
}

function door(fn) {
  return async (args, caller, ctx) => {
    if (!s.settings.door) {
      throw new Error('The Pomodoro tile is not open to Claude sessions. The user can turn on "Let Claude sessions use the timer" in its settings (⚙).')
    }
    return fn(args, ctx ?? {})
  }
}
ws.door.handle('status', door(() => status()))
ws.door.handle(
  'start',
  door((args, { session }) => {
    if (args.length) s.intent = args.join(' ').trim().slice(0, 120)
    if (session) s.linked = session
    if (!s.running) start()
    else save()
    return status()
  })
)
ws.door.handle(
  'pause',
  door(() => {
    if (s.running) pause()
    return status()
  })
)
ws.door.handle(
  'skip',
  door(() => {
    advance(false)
    return status()
  })
)
ws.door.handle(
  'extend',
  door((args) => {
    const min = Math.round(Number(args[0] ?? 5))
    if (!(min >= 1 && min <= 60)) throw new Error('extend takes minutes, 1 to 60')
    extend(min)
    return status()
  })
)

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

// --- view: shared pieces ---------------------------------------------------------------------

const R = 52
const C = 2 * Math.PI * R
let ring, timeEl, headKey = null, shownDay = today()

function render() {
  stale = false
  shownDay = today()
  document.body.className = `phase-${s.phase}${s.running ? ' running' : ''}${ws.view === 'pane' ? ' in-pane' : ''}`
  ring = timeEl = null
  body.replaceChildren(editing ? settingsView() : ws.view === 'pane' ? paneView() : tileView())
  tick()
}

function dial() {
  ring = el('svg:circle', { class: 'arc', cx: 60, cy: 60, r: R, 'stroke-dasharray': C.toFixed(2) })
  timeEl = el('div', { class: 'time' })
  const label = s.phase === 'focus' ? `Focus · ${Math.min(s.cycle + 1, s.settings.every)}/${s.settings.every}` : PHASES[s.phase]
  return el(
    'div',
    { class: 'dial' },
    el('svg:svg', { viewBox: '0 0 120 120', class: 'ring' }, el('svg:circle', { class: 'track', cx: 60, cy: 60, r: R }), ring),
    el('div', { class: 'face' }, timeEl, el('div', { class: 'label' }, label))
  )
}

function tabs() {
  return el(
    'div',
    { class: 'tabs', role: 'tablist' },
    Object.entries({ focus: 'Focus', short: 'Short', long: 'Long' }).map(([p, name]) =>
      el('button', { class: p === s.phase ? `tab on tab-${p}` : `tab tab-${p}`, role: 'tab', 'aria-selected': String(p === s.phase), onclick: () => choose(p) }, name)
    )
  )
}

let intentTimer = 0
function intent() {
  if (!s.settings.ask) return null
  return el('input', {
    class: 'intent',
    type: 'text',
    maxLength: 120,
    placeholder: 'What are you working on?',
    value: s.intent,
    spellcheck: false,
    oninput: (e) => {
      s.intent = e.target.value
      clearTimeout(intentTimer)
      intentTimer = setTimeout(() => ws.storage.set('state', s), 400)
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.target.blur()
        if (!s.running) start()
        else save()
      } else if (e.key === 'Escape') e.target.blur()
    }
  })
}

function controls() {
  return el(
    'div',
    { class: 'controls' },
    el('button', { class: 'primary', onclick: () => (s.running ? pause() : start()) }, s.running ? 'Pause' : s.left != null ? 'Resume' : 'Start'),
    el('button', { title: 'Add 5 minutes to this phase', onclick: () => extend(5) }, '+5'),
    el('button', { title: 'Skip to the next phase', onclick: () => advance(false) }, 'Skip'),
    el('button', { class: 'icon', title: 'Reset this phase', 'aria-label': 'Reset this phase', onclick: reset }, '↺')
  )
}

function goalDots() {
  const n = doneOn(today()).length
  const goal = s.settings.goal
  return el(
    'span',
    { class: 'goal', title: `${n} of ${goal} focus blocks today` },
    el(
      'span',
      { class: 'dots' },
      Array.from({ length: goal }, (_, i) => el('span', { class: i < n ? 'dot full' : 'dot' }))
    ),
    el('span', { class: 'muted' }, n > goal ? `+${n - goal}` : `${n}/${goal}`)
  )
}

const gear = () =>
  el('button', { class: 'bare', title: 'Settings', 'aria-label': 'Settings', onclick: () => ((editing = true), render()) }, '⚙')

// --- view: the tile --------------------------------------------------------------------------

function tileView() {
  return el(
    'div',
    { class: 'timer' },
    dial(),
    el(
      'div',
      { class: 'side' },
      tabs(),
      intent(),
      controls(),
      el(
        'div',
        { class: 'stats' },
        goalDots(),
        el('span', { class: 'tools' },
          el('button', { class: 'bare', title: 'Open large, with your history', 'aria-label': 'Open large', onclick: () => ws.openPane().catch(() => {}) }, '⤢'),
          gear()
        )
      )
    )
  )
}

// --- view: the pane (the timer, and the history beside it) ----------------------------------

function countsByDay() {
  const m = new Map()
  for (const e of log) {
    const d = dayOf(e.t)
    const c = m.get(d) ?? { n: 0, min: 0 }
    c.n += 1
    c.min += e.m ?? 0
    m.set(d, c)
  }
  return m
}

function streak(days) {
  let t = Date.now()
  if (!days.has(dayOf(t))) t -= DAY // today isn't over: a streak still counts from yesterday
  let n = 0
  while (days.has(dayOf(t))) {
    n += 1
    t -= DAY
  }
  return n
}

const hours = (min) => (min >= 60 ? `${(min / 60).toFixed(min >= 600 ? 0 : 1)} h` : `${min} min`)

function card(label, value, sub) {
  return el('div', { class: 'card' }, el('div', { class: 'card-label' }, label), el('div', { class: 'card-value' }, value), sub && el('div', { class: 'muted small' }, sub))
}

function paneView() {
  const days = countsByDay()
  const t = days.get(today()) ?? { n: 0, min: 0 }
  const week = Array.from({ length: 7 }, (_, i) => {
    const at = Date.now() - (6 - i) * DAY
    return { at, ...(days.get(dayOf(at)) ?? { n: 0, min: 0 }) }
  })
  const weekN = week.reduce((a, d) => a + d.n, 0)
  const weekMin = week.reduce((a, d) => a + d.min, 0)
  const peak = Math.max(s.settings.goal, ...week.map((d) => d.n))

  // 16 weeks, a column a week, Sunday on top, ending with this week.
  const WEEKS = 16
  const first = new Date()
  first.setHours(12, 0, 0, 0)
  first.setDate(first.getDate() - first.getDay() - (WEEKS - 1) * 7)
  const level = (n) => (n === 0 ? 0 : n >= s.settings.goal ? 4 : Math.min(3, 1 + Math.floor((n / s.settings.goal) * 3)))
  const cells = []
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = new Date(first.getTime() + i * DAY)
    const future = d.getTime() > Date.now()
    const n = days.get(dayOf(d))?.n ?? 0
    cells.push(el('span', { class: future ? 'cell future' : `cell l${level(n)}`, title: `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${n}` }))
  }

  // By project, this week.
  const since = Date.now() - 6 * DAY
  const byProject = new Map()
  for (const e of log) {
    if (dayOf(e.t) < dayOf(since)) continue
    const k = e.project ?? 'No project'
    byProject.set(k, (byProject.get(k) ?? 0) + (e.m ?? 0))
  }
  const projects = [...byProject].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const topMin = projects[0]?.[1] ?? 1

  const todays = log.filter((e) => dayOf(e.t) === today()).reverse()
  const timeOf = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  return el(
    'div',
    { class: 'pane' },
    el(
      'section',
      { class: 'pane-timer' },
      dial(),
      tabs(),
      intent(),
      controls(),
      el('div', { class: 'stats' }, goalDots(), el('span', { class: 'tools' },
        el('button', { class: 'bare', title: 'Back to the column', 'aria-label': 'Back to the column', onclick: () => ws.closePane().catch(() => {}) }, '⤡'),
        gear()
      ))
    ),
    el(
      'section',
      { class: 'pane-history' },
      el(
        'div',
        { class: 'cards' },
        card('Today', `${t.n} / ${s.settings.goal}`, hours(t.min)),
        card('Last 7 days', String(weekN), hours(weekMin)),
        card('Streak', `${streak(days)} ${streak(days) === 1 ? 'day' : 'days'}`, 'days with a focus block')
      ),
      el('h3', {}, 'Last 7 days'),
      el(
        'div',
        { class: 'bars' },
        week.map((d) =>
          el(
            'div',
            { class: 'bar-col', title: `${d.n} focus blocks, ${hours(d.min)}` },
            el('span', { class: 'bar-n muted' }, d.n || ''),
            el('div', { class: 'bar-track' }, el('div', { class: dayOf(d.at) === today() ? 'bar today' : 'bar', vars: { '--h': String((d.n / peak) * 100) } })),
            el('span', { class: 'bar-day muted' }, new Date(d.at).toLocaleDateString(undefined, { weekday: 'short' }))
          )
        ),
        el('div', { class: 'goal-line', vars: { '--h': String((s.settings.goal / peak) * 100) }, title: `Goal: ${s.settings.goal}` })
      ),
      el('h3', {}, `${WEEKS} weeks`),
      el('div', { class: 'heat' }, cells),
      el('h3', {}, 'By project, last 7 days'),
      projects.length
        ? el(
            'div',
            { class: 'projects' },
            projects.map(([name, min]) =>
              el(
                'div',
                { class: 'proj' },
                el('span', { class: 'proj-name', title: name }, name),
                el('span', { class: 'proj-track' }, el('span', { class: 'proj-bar', vars: { '--w': String((min / topMin) * 100) } })),
                el('span', { class: 'muted proj-min' }, hours(min))
              )
            )
          )
        : el('p', { class: 'muted small' }, 'Finished focus blocks are filed under the project of the Claude session you were in.'),
      el('h3', {}, 'Today'),
      todays.length
        ? el(
            'ul',
            { class: 'today' },
            todays.map((e) =>
              el(
                'li',
                {},
                el('span', { class: 'muted when' }, timeOf(e.t)),
                el('span', { class: e.intent ? 'what' : 'what muted' }, e.intent ?? `${e.m} min focus`),
                e.project && el('span', { class: 'tag' }, e.project)
              )
            )
          )
        : el('p', { class: 'muted small' }, 'Nothing yet today.')
    )
  )
}

// --- view: settings --------------------------------------------------------------------------

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
  const check = (key, label, hint) =>
    el(
      'label',
      { class: 'check', title: hint },
      el('input', { type: 'checkbox', checked: s.settings[key], onchange: (e) => ((s.settings[key] = e.target.checked), save()) }),
      label
    )

  let pick = null
  if (s.settings.announce) {
    pick = el('select', {
      class: 'pick',
      onchange: (e) => {
        s.linked = e.target.value || null
        e.target.blur()
        save()
      }
    }, el('option', { value: '' }, 'The focused session'))
    listSessions().then((list) => {
      for (const x of list) pick.append(el('option', { value: x.id, selected: x.id === s.linked }, `${x.name} · ${base(x.root ?? x.project) ?? ''}`))
      if (s.linked && !list.some((x) => x.id === s.linked)) pick.append(el('option', { value: s.linked, selected: true, disabled: true }, 'A session that has closed'))
    })
  }

  return el(
    'div',
    { class: 'settings' },
    el(
      'div',
      { class: 'grid' },
      num('focus', 'Focus (min)', 1, 180),
      num('short', 'Short break', 1, 60),
      num('long', 'Long break', 1, 120),
      num('every', 'Long after', 1, 12),
      num('goal', 'Daily goal', 1, 16)
    ),
    el(
      'div',
      { class: 'row' },
      check('auto', 'Start next phase on its own'),
      check('sound', 'Chime'),
      check('ask', 'Ask what I’m working on')
    ),
    el('div', { class: 'section-label' }, 'Claude sessions'),
    el(
      'div',
      { class: 'col' },
      check('door', 'Let Claude sessions use the timer', 'Sessions can check, start, pause, skip and extend it: node "$WORKSHOP_TILE" pomodoro status'),
      check('announce', 'Tell a session when a phase ends', 'Types a one-line note into the session and sends it'),
      pick && el('label', { class: 'field inline' }, el('span', {}, 'Tell'), pick),
      pick && el('p', { class: 'muted small' }, 'A session that starts the timer through the door becomes the one told. Skipped while a session is waiting on a permission prompt.')
    ),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'link', onclick: () => ((log = log.filter((e) => dayOf(e.t) !== today())), (s.cycle = 0), saveLog(), save()) }, 'Clear today'),
      el('button', { class: 'link', onclick: () => ((s.settings = { ...DEFAULTS }), save()) }, 'Defaults'),
      el('button', { class: 'primary done', onclick: () => ((editing = false), render()) }, 'Done')
    )
  )
}

// --- the clock -------------------------------------------------------------------------------

function tick() {
  if (s.running && Date.now() >= s.endsAt) return void advance(true)
  if (today() !== shownDay) return redraw()
  const left = remaining()
  if (timeEl) timeEl.textContent = fmt(left)
  if (ring) ring.setAttribute('stroke-dashoffset', (C * (1 - Math.min(1, left / total()))).toFixed(2))
  const badge = s.running ? fmt(left) : s.left != null ? `⏸ ${fmt(left)}` : ''
  const title = `${PHASES[s.phase]}${s.phase === 'focus' && s.intent.trim() ? ` · ${s.intent.trim()}` : ''}`.slice(0, 60)
  const key = title + badge
  if (key !== headKey) {
    headKey = key
    ws.head.set({ title, badge }).catch(() => {})
  }
}

document.addEventListener('keydown', (e) => {
  if (editing || e.target.closest?.('input, button, select')) return
  if (e.key === ' ') {
    e.preventDefault()
    s.running ? pause() : start()
  }
})

render()
setInterval(tick, 250)
