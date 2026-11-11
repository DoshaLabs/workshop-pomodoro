# Pomodoro

A pomodoro timer for [workshop](https://github.com/DoshaLabs/workshop)'s tile column: focus, a
short break, and a long break after every few focus rounds. The time left shows on the tile's
head. A soft chime and a notification say when a phase is over.

## What it asks for

- `storage`: the timer is kept as an end time, so it keeps counting across reloads and restarts.
  The day's count and your settings are kept there too.
- `notify`: a notification when a phase ends.

Nothing leaves your Mac. The chime is made in the page; nothing is fetched.

## Install

In workshop, press `+` at the foot of the tile column, open Marketplace, and install Pomodoro.

## Use

Start, Pause, Reset, Skip. Space starts and pauses when the tile has focus. The gear sets the
lengths (minutes), how many focus rounds come before a long break, whether the next phase starts
on its own, and the chime.

## Develop

Plain HTML, CSS and JavaScript in `dist/`, no build step. Load the folder with
`workshop tile dev .` and it reloads on save. `CLAUDE.md` is the tile contract, written for the
Claude session that edits the tile. Check it with `workshop tile check .` before a release.

## Licence

MIT. See `LICENSE`.
