# Pomodoro

A pomodoro timer for [workshop](https://github.com/DoshaLabs/workshop)'s tile column: focus, a
short break, and a long break after every few focus rounds. The time left shows on the tile's
head. A soft chime and a notification say when a phase is over. Each phase has its own colour,
dots count toward a daily goal, and opened large it shows your history: the last 7 days, 16
weeks as a heatmap, time by project, and what you worked on today.

If you let it, Claude sessions can drive the timer, and the tile tells a session when a focus
block or a break ends.

## What it asks for

- `storage`: the timer is kept as an end time, so it keeps counting across reloads and restarts.
  The day's count and your settings are kept there too.
- `notify`: a notification when a phase ends.
- `sessions: "write"`: to file each focus block under the project of the Claude session you were
  in, and, only if you turn it on, to type a one-line `[Pomodoro] …` note into a session when a
  phase ends. It never types into a session waiting on a permission prompt.
- `door` (`status`, `start`, `pause`, `skip`, `extend`): Claude sessions can check and drive the
  timer, only if you turn on "Let Claude sessions use the timer" in its settings. A skill in
  `plugin/` teaches new sessions how.

Nothing leaves your Mac. The chime is made in the page; nothing is fetched.

## Install

In workshop, press `+` at the foot of the tile column, open Marketplace, and install Pomodoro.

## Use

Start, Pause, +5, Skip, Reset. Space starts and pauses when the tile has focus; Enter in "What are
you working on?" starts. ⤢ opens it large. The gear sets the lengths (minutes), how many focus
rounds come before a long break, the daily goal, whether the next phase starts on its own, the
chime, the "working on" field, and the two Claude session settings (both off to begin with).

From a Claude session (with the door on):

```bash
node "$WORKSHOP_TILE" pomodoro start fix the auth tests
node "$WORKSHOP_TILE" pomodoro status
node "$WORKSHOP_TILE" pomodoro extend 10
```

## Develop

Plain HTML, CSS and JavaScript in `dist/`, no build step. Load the folder with
`workshop tile dev .` and it reloads on save. `CLAUDE.md` is the tile contract, written for the
Claude session that edits the tile. Check it with `workshop tile check .` before a release.

## Licence

MIT. See `LICENSE`.
