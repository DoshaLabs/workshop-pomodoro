---
name: pomodoro
description: Check, start, pause, skip or extend the user's Pomodoro timer in workshop. Use when the user says "start a pomodoro", "start a focus block on X", "how long is left", "pause the timer", "skip the break", "give me 5 more minutes", or asks how much they have focused today. Also explains the "[Pomodoro] …" lines the tile types into this session when a phase ends.
---

# Pomodoro

The Pomodoro tile in workshop's column answers these from the shell. Each prints JSON and exits 1
on a refusal:

```bash
node "$WORKSHOP_TILE" pomodoro status                 # phase, running, remaining, intent, today/goal
node "$WORKSHOP_TILE" pomodoro start [what you are working on…]   # starts or resumes the current phase
node "$WORKSHOP_TILE" pomodoro pause
node "$WORKSHOP_TILE" pomodoro skip                   # to the next phase; a skipped focus block is not counted
node "$WORKSHOP_TILE" pomodoro extend [minutes]       # default 5, 1 to 60
```

- `start` with words sets the intention shown on the tile (e.g. `start fix the auth tests`), and
  makes this session the one the tile tells when a phase ends (if the user has that turned on).
- If the call is refused because the tile is "not open to Claude sessions", tell the user they
  can turn on **Let Claude sessions use the timer** in the tile's settings (⚙). Don't retry.
- If it fails because the tile is off, ask the user to turn the Pomodoro tile on.

## Lines the tile types into this session

When the user has **Tell a session when a phase ends** on, a message like this arrives as if they
typed it:

- `[Pomodoro] Focus block done … Short break of 5 min starts now: …` Finish the step you are on
  (don't start anything new), then stop and give a two-line note of where things stand, so the
  user can pick it up after the break. Keep it short: they are on a break.
- `[Pomodoro] Break over. 25 min of focus starts now …` Carry on from where you stopped, starting
  with a one-line reminder of the next step.
