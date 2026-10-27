# Dynamic Island for GNOME

Turns the GNOME top bar into a floating, macOS-style island.

The clock and the control centre move into a rounded pill at the top centre of the
screen. The bar itself reserves no space, so windows use the full screen height and the
island simply floats over them. Hovering the island unfolds it into a panel with media
controls and a focus timer.

The island is the panel's own centre box, not a second widget drawn next to it, so it
carries the real `dateMenu` and `quickSettings`: clicking the clock opens the real
calendar, and clicking the icons opens the real control centre.

## Requirements

- GNOME Shell **50 or 51**
- Wayland or X11

Built and tested on Ubuntu 26.04 with GNOME Shell 50 under Wayland.

## Install

```bash
git clone https://github.com/EnzoFB06/dynamic-island-gnome.git
cd dynamic-island-gnome
make install
```

GNOME Shell only discovers a newly installed extension at startup:

- **Wayland** — log out and back in
- **X11** — <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`, <kbd>Enter</kbd>

Then enable it:

```bash
gnome-extensions enable dynamic-island@EnzoFB06.github.com
```

Open the settings with `gnome-extensions prefs dynamic-island@EnzoFB06.github.com`, or
from the Extensions app.

To remove it: `make uninstall`.

## What it does

**Collapsed** — a pill at the top centre with the time and the system indicators. Its
top corners flare into the screen edge with a concave curve, which `border-radius`
cannot express, so each corner is a small `St.DrawingArea` filled with Cairo and kept in
step with the island as it grows.

**Expanded** — hovering for half a second grows the island itself into a panel. It does
not spawn a second surface underneath: `Panel.vfunc_allocate()` pins the centre box to
the panel's height, so the panel's height is what grows, and the content is stacked
inside the island.

The expanded panel is a **deck of panes**, one at a time, and the wheel moves
between them, each one rising or descending into place as it fades, from the
side the wheel came from. A column of dots down the right edge carries the
position -- the wheel moves vertically, the panes move vertically, the indicator
agrees with both -- and the pane's name appears underneath, fading back once you
have landed. The island takes the size of
whichever pane is up -- height always, and width when a pane asks for more --
so each one gets the room it needs rather than the room the largest one needs.

The panes:

- **Now playing** — title, artist, cover art and transport controls for any MPRIS
  player. Remote cover art (Spotify serves an `https` URL) is downloaded once into
  `~/.cache/<uuid>/` and painted from there.
- **A focus timer** — a ring of dots, each worth the session length divided by their
  count, going dark as their share elapses. The length is set from inside the island
  (the − and + buttons, or scrolling on the ring) as well as from the preferences. While
  a session runs, a coloured dot sits next to the clock in the collapsed island: blue
  while running, amber while paused.
- **Agents** — one robot per running Claude Code session, each drawn rather than
  assembled from icons, because the state is the pose: a working agent bobs and
  its eyes scan, one waiting on you holds still with its eyes wide, one that has
  finished tilts its head with its eyes shut. Up to three of them also sit beside
  the clock in the collapsed pill, so an agent working in the background is
  visible without opening anything. This needs the hook below.
- **Search** — the shell's own `SearchResultsView`, the object the overview uses,
  so everything the desktop can already find is found here too and ranked the
  same way. Click the field to type: the island lives in the shell's chrome, and
  chrome does not receive key events, so the pane takes a modal grab exactly as
  the overview does — on the click, never merely because the pane is on screen.
- **System** — processor, memory and disk as rings, with network throughput and
  uptime beside them, sampled only while the pane is on screen.

## Events

Four things are worth interrupting for, each with its own motion: a notification
ripples outward, a charger fills a ring, a Bluetooth device sends arcs, and a
finished focus session throws its ring's dots off the edge.

They do not deform the island. Each gets a **detached capsule** -- a pill of its
own, floating below the top edge -- which is what lets a notification appear
while the island itself is tucked away over a fullscreen window: the two are
separate chrome actors, and only one of them is hiding.

The capsule plays in three acts, after
[ActivSpot](https://github.com/Devvvmn/ActivSpot)'s notification island:

1. **full** — wide, with the icon, the title and the body, held long enough to
   read;
2. **compact** — it draws in to a small pill carrying the icon and one line, and
   lingers there, the part you catch out of the corner of your eye after you
   have stopped reading;
3. **away** — it lifts, shrinks and fades.

Hovering holds whichever act it is in; clicking activates the notification the
way clicking the shell's own banner does. Events queue rather than overwrite,
and the capsule shows exactly the set the shell would have bannered -- the same
policy tests, so a muted application or a low-urgency background update stays
quiet here too.

## Claude Code agents

The extension cannot see inside Claude Code, so Claude Code reports to it: a
hook writes one small JSON file per session into `$XDG_RUNTIME_DIR/dynamic-island/agents/`,
and the island watches that directory. No polling of processes, no reading of
logs.

```bash
make show-hooks     # print what would be written, change nothing
make install-hooks  # register in ~/.claude/settings.json
make uninstall-hooks
```

It merges into whatever that file already holds and backs it up first. The state
directory lives under `XDG_RUNTIME_DIR`, so it is wiped on reboot, and the island
ages out any session that stops reporting. Entirely optional — every other pane
works without it.

**Auto-hide** — by default the island tucks itself away over a fullscreen window and
comes back when the pointer reaches the top. The trigger strip spans the island's width
only, never the whole screen, so the window buttons in the top corners stay clickable.

## Settings

| Group | What it covers |
| --- | --- |
| Shape | Notch or floating pill, corner radius, height, inner padding, top gap |
| Appearance | Background opacity, frosted-glass blur, concave corners, island on every monitor |
| Auto-hide | When to hide (never / fullscreen / fullscreen and maximized), trigger strip size, delays, animation duration |
| Timer | Session length, step of the − and + buttons, number of dots on the ring |
| Behaviour | Reclaim the panel's reserved space, keep the island over fullscreen windows, repair the dock in fullscreen, hide the Activities button |

## Interoperability

Two other extensions overlap with this one, and both are handled automatically when they
are installed — nothing to configure:

- **Blur My Shell** owns `panel.set_style()` and rewrites it on every overview
  transition. The island's transparency therefore lives in this extension's stylesheet
  rather than in an inline style, so the two never fight over the same property. Blur My
  Shell's own panel blur is suspended while this extension is enabled, and restored when
  it is disabled.
- **Dash to Dock Lite** refuses to slide its dock in, and stops its render loop, whenever
  the monitor counts as fullscreen — which leaves the dock invisible but still clickable.
  Those guards are neutralised for the duration of each call, through GNOME's own
  `InjectionManager`. That extension's files are never modified, so its updates are safe.

## Known limitations

- **The interface strings are in French.** There is no gettext setup yet; translations
  are welcome.
- **Secondary monitors get a clock only.** The shell has a single panel, so only the
  primary monitor can host the real clock and control centre. Other monitors get a
  matching island driven by the same `GnomeDesktop.WallClock`, with the same hover
  behaviour. This path is written but has not been tested on a real multi-monitor setup.
- **Compositing stays on over fullscreen windows.** A fullscreen window is normally
  unredirected by Mutter, which bypasses compositing entirely and means nothing the shell
  draws appears over it — the island included. This extension calls
  `disable_unredirect()` so the island can be shown, at some cost in power and
  performance during fullscreen video.
- **Cover art accumulates** in `~/.cache/<uuid>/`, roughly 60 kB per album, with no
  pruning yet.

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE).
