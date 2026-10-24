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

The expanded panel holds:

- **Now playing** — title, artist, cover art and transport controls for any MPRIS
  player. Remote cover art (Spotify serves an `https` URL) is downloaded once into
  `~/.cache/<uuid>/` and painted from there.
- **A focus timer** — a ring of dots, each worth the session length divided by their
  count, going dark as their share elapses. The length is set from inside the island
  (the − and + buttons, or scrolling on the ring) as well as from the preferences. While
  a session runs, a coloured dot sits next to the clock in the collapsed island: blue
  while running, amber while paused.

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
