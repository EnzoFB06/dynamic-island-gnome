/* Dynamic Island -- GNOME Shell 50
 *
 * Turns the existing top panel INTO a macOS-style island rather than hiding it
 * and building a replacement alongside. That distinction matters: panelBox is
 * registered as chrome with `trackFullscreen: true`, and
 * LayoutManager._updateActorVisibility() reassigns `actor.visible` outright on
 * every visibility pass, so any hide() we apply is undone moments later.
 *
 * So instead:
 *   - the panel background goes fully transparent and keeps only its centre box,
 *     styled as a rounded island;
 *   - dateMenu and quickSettings both live in that centre box, so the clock and
 *     the wifi/battery/volume icons share one island and the screen corners stay
 *     free for window controls;
 *   - the panel actor becomes non-reactive, so clicks land on the window
 *     underneath everywhere except on the buttons themselves;
 *   - the panel's strut is dropped, so windows reclaim the full screen height
 *     and the island overlays them instead of reserving space.
 *
 * Dropping the strut has one consequence worth spelling out, because it drives
 * most of what follows: a maximized window then covers the monitor exactly, and
 * Mutter reports that monitor as being in fullscreen. Everything keyed on
 * `monitor.inFullscreen` reacts -- the shell hides the panel, and dash2dock-lite
 * refuses to slide its dock in and stops its render loop. Both are handled here
 * so a maximized window behaves like a maximized window.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

/* Indicators gathered into the island, in display order. */
const ISLAND_ROLES = ['dateMenu', 'quickSettings'];

const WATCHED_KEYS = [
    'style', 'bg-opacity', 'corner-radius', 'island-height', 'top-gap',
    'side-padding', 'reclaim-space', 'hide-activities',
    'island-blur', 'blur-radius', 'blur-brightness',
    'keep-in-fullscreen', 'fix-dock-fullscreen',
    'autohide-mode', 'reveal-edge', 'hide-delay', 'animation-duration',
    'expand-on-hover', 'expand-delay', 'shelf-width',
    'all-monitors', 'reveal-margin', 'concave-corners', 'ring-dots',
];

/* Blur My Shell paints its own full-width blurred strip behind the panel and
 * overrides the panel background, which would sit right through our
 * transparency. Suspend just that component while we are enabled. */
const BMS_UUID = 'blur-my-shell@aunetx';
const BMS_PANEL_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.panel';

const BLUR_EFFECT_NAME = 'dynamic-island-blur';

/* dash2dock-lite. Its dock actor carries this name (dock.js), which is how we
 * recognise it among the shell's tracked chrome. */
const D2D_UUID = 'dash2dock-lite@icedman.github.com';
const DOCK_ACTOR_NAME = 'dashtodockContainer';
const PANEL_ACTOR_NAME = 'panelBox';

/* Timer surfaces. The two accents differ in lightness as well as hue, so the
 * running and paused states stay apart without relying on colour alone. */
const RING_SIZE = 66;
const RING_DOT_RADIUS = 3.2;
const DOT_SIZE = 7;
/* How long a fullscreen state must hold before the island reacts to it. */
const AUTOHIDE_SETTLE_MS = 250;
/* Album art runs to a few tens of kilobytes; well past this it is not a cover. */
const COVER_MAX_BYTES = 5 * 1024 * 1024;
const ACCENT_RUNNING = '#6aa9e0';
const ACCENT_PAUSED = '#e8a44c';
const RGB_RUNNING = [0x6a / 255, 0xa9 / 255, 0xe0 / 255];
const RGB_PAUSED = [0xe8 / 255, 0xa4 / 255, 0x4c / 255];

export default class DynamicIslandExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._signals = [];
        this._origin = new Map();
        this._injections = new InjectionManager();

        const panel = Main.panel;
        this._panelStyleBackup = panel.get_style();
        this._panelReactiveBackup = panel.reactive;
        this._panelBoxReactiveBackup = Main.layoutManager.panelBox.reactive;

        this._revealed = true;
        this._hideTimer = 0;

        this._suspendBlurMyShellPanel();
        this._dropUnredirection();
        this._buildUnits();
        this._installVisibilityGuard();
        this._unguardDockFullscreen();
        /* The body has to exist before the indicators are gathered, or they
         * land straight in the centre box instead of the island's top row. */
        this._buildIslandBody();
        this._gatherIndicators();
        this._setupMpris();
        this._trackFocusWindow();
        this._apply();

        /* The shell rebuilds the panel boxes on every session mode change
         * (lock, unlock, greeter), which puts quickSettings back in the right
         * box and re-shows what we hid. Reclaim it afterwards. */
        this._connect(Main.sessionMode, 'updated', () => {
            this._gatherIndicators();
            this._apply();
        });

        /* Mutter re-evaluates a monitor's fullscreen state on every stacking
         * change, and it can flip true for a fraction of a second with no
         * window actually entering fullscreen -- measured while a floating
         * Firefox window was used over a maximized one. Reacting to each flip
         * made the island hide and reappear in a loop. These signals are
         * therefore debounced: a state that does not survive a moment is not a
         * state worth animating. */
        this._connect(global.display, 'in-fullscreen-changed',
            () => this._queueSyncAutoHide());
        this._connect(global.display, 'notify::focus-window', () => {
            this._trackFocusWindow();
            this._queueSyncAutoHide();
        });
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            this._rebuildSatellites();
            this._placeUnits();
            this._syncAutoHide();
        });

        /* The overview is never something to hide from. */
        this._connect(Main.overview, 'showing', () => this._syncAutoHide());
        this._connect(Main.overview, 'hidden', () => this._syncAutoHide());

        for (const key of WATCHED_KEYS)
            this._connect(this._settings, `changed::${key}`, () => this._apply());

        /* The duration is edited from inside the island, so it changes often and
         * needs only the timer resynced -- not the whole layout. */
        this._connect(this._settings, 'changed::focus-duration',
            () => this._onDurationChanged());

        /* Clicks in the top strip belong to the window underneath, and that
         * depends on two actors staying non-reactive. A one-shot assignment is
         * not enough: anything that re-enables them -- including the gap
         * between a disable() and the enable() that follows it -- hands the
         * whole strip back to the shell and the window's buttons stop
         * responding. Pin them instead.
         *
         * disable() disconnects these before restoring the saved values, so
         * teardown is unaffected. */
        for (const actor of [Main.panel, Main.layoutManager.panelBox]) {
            this._connect(actor, 'notify::reactive', () => {
                if (actor.reactive)
                    actor.reactive = false;
            });
        }

        /* The panel's transparency is an inline style, and the theme's own
         * "#panel { background-color: #131313 !important }" takes the panel
         * straight back as a solid black band the moment that inline style is
         * dropped. Reloading the theme is routine here -- light-style does it
         * on every colour-scheme change -- so rather than trusting a one-shot
         * assignment, reassert the whole look whenever the theme changes. */
        this._connect(St.ThemeContext.get_for_stage(global.stage), 'changed',
            () => this._apply());
    }

    disable() {
        /* enable() can fail part way through -- a broken schema, for one -- and
         * the shell still calls disable() on the half-built object. Every step
         * below has to tolerate the pieces it expects being absent. */
        for (const [obj, id] of this._signals ?? []) {
            try {
                obj.disconnect(id);
            } catch (e) {
                /* The object may already be finalised. */
            }
        }
        this._signals = [];

        const panel = Main.panel;

        this._cancelAllHideTimers();
        this._cancelSyncTimer();
        this._cancelExpandTimer();
        this._teardownMpris();
        this._untrackFocusWindow();
        this._setStrut(true);
        panel.remove_all_transitions();
        panel.height = -1; /* back to the theme's own height */
        panel.set_style(this._panelStyleBackup);
        panel.reactive = this._panelReactiveBackup;
        Main.layoutManager.panelBox.reactive = this._panelBoxReactiveBackup;
        panel._centerBox.set_style(null);
        panel._centerBox.margin_top = 0;
        panel._centerBox.remove_effect_by_name(BLUR_EFFECT_NAME);
        panel._leftBox.show();
        panel._rightBox.show();

        /* Put the island back where it belongs before we stop managing it. */
        panel._centerBox.remove_all_transitions();
        panel._centerBox.translation_y = 0;
        panel._centerBox.opacity = 255;
        panel._centerBox.reactive = false;

        this._destroyUnits();

        this._restoreUnredirection();
        /* Must come before _destroyIslandBody(): the real dateMenu and
         * quickSettings live in our top row, and destroying that subtree with
         * them still inside destroys the shell's own widgets for good. */
        this._restoreIndicators();
        this._destroyIslandBody();
        this._restoreBlurMyShellPanel();

        /* Drops every override in one go: the visibility guard and the
         * dash2dock-lite fullscreen shims. */
        this._injections?.clear();
        this._injections = null;

        this._origin?.clear();
        this._settings = null;

        /* Let the shell re-decide what should be hidden now that it is back in
         * charge of fullscreen visibility. */
        Main.layoutManager._updateVisibility();
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    /* ---------------------------------------------------------------- style */

    _apply() {
        const panel = Main.panel;
        const s = this._settings;

        const floating = s.get_string('style') === 'floating';
        const opacity = s.get_double('bg-opacity');
        const radius = s.get_int('corner-radius');
        const height = s.get_int('island-height');
        const padding = s.get_int('side-padding');
        const gap = floating ? s.get_int('top-gap') : 0;

        /* The panel's transparency is NOT set here: it lives in the extension's
         * stylesheet, because Blur My Shell owns panel.set_style() and rewrites
         * it on every overview transition. See the #panel rule there. */

        /* The height is a Clutter property rather than a CSS one, because the
         * expansion eases it and a theme-node height would override the
         * animation at every frame. */
        if (!this._expanded)
            panel.height = height + gap;

        /* Empty areas must not swallow clicks; the buttons carry reactive:true
         * themselves, and Clutter still picks reactive children through a
         * non-reactive parent, so they keep working.
         *
         * panelBox matters as much as the panel: it is the layout manager's own
         * container, it spans the full monitor width, and it is reactive by
         * default -- which swallowed every click in the top strip, including a
         * maximized window's close and maximize buttons sitting under it. */
        panel.reactive = false;
        Main.layoutManager.panelBox.reactive = false;

        this._styleIslands();

        /* St does not apply CSS margins here, but Clutter honours this one and
         * Panel.vfunc_allocate() goes through clutter_actor_allocate(). */
        panel._centerBox.margin_top = gap;

        /* With both side boxes gone, vfunc_allocate() centres the island on the
         * work area and the screen corners stay clear for window controls. */
        panel._rightBox.hide();
        if (s.get_boolean('hide-activities'))
            panel._leftBox.hide();
        else
            panel._leftBox.show();

        /* Cached because the expansion reads these on every frame, and a
         * GSettings lookup 60 times a second for values that only change when
         * the user edits them is waste. */
        this._geom = {
            radius,
            concave: s.get_boolean('concave-corners') && !floating,
            collapsedHeight: height + gap,
            opacity,
        };

        this._applyBlur();
        this._setStrut(!s.get_boolean('reclaim-space'));
        this._syncProtectedVisibility();
        this._placeUnits();
        this._placeCorners();
        this._syncAutoHide();
    }

    /* ------------------------------------------------------ unredirection */

    /* The decisive piece. A genuinely fullscreen window gets unredirected:
     * Mutter scans it out directly and bypasses compositing, so nothing the
     * shell draws appears over it -- the island was neither hidden nor
     * occluded, it simply was not being composited. Mutter reference-counts
     * these calls, so ours is paired exactly once. */
    _dropUnredirection() {
        if (this._unredirectDropped)
            return;

        global.compositor.disable_unredirect();
        this._unredirectDropped = true;
    }

    _restoreUnredirection() {
        if (!this._unredirectDropped)
            return;

        global.compositor.enable_unredirect();
        this._unredirectDropped = false;
    }

    /* --------------------------------------------------------- auto-hide */

    /* --------------------------------------------------------- auto-hide */

    /* Each monitor gets a "unit": an island actor plus the thin strip that
     * brings it back. The primary monitor's island is the panel's own centre
     * box, carrying the real clock and control centre; the shell has only one
     * panel, so every other monitor gets a matching island with a clock of its
     * own, driven by the same GnomeDesktop.WallClock the shell uses. */
    _buildUnits() {
        this._units = [];
        this._clock = null;

        this._addUnit({
            island: Main.panel._centerBox,
            monitorIndex: Main.layoutManager.primaryIndex,
            isPrimary: true,
        });

        this._buildSatellites();
        this._trackMenus();
    }

    _buildSatellites() {
        if (!this._settings.get_boolean('all-monitors'))
            return;

        const lm = Main.layoutManager;
        const others = lm.monitors.filter(m => m.index !== lm.primaryIndex);
        if (others.length === 0)
            return;

        /* One clock for all satellites; the shell's own source, so the format
         * and the tick match the real one exactly. */
        this._clock = new GnomeDesktop.WallClock();

        for (const monitor of others) {
            const island = new St.BoxLayout({
                name: 'dynamicIslandSatellite',
                reactive: true,
                track_hover: true,
            });

            const label = new St.Label({
                style_class: 'di-satellite-clock',
                y_align: Clutter.ActorAlign.CENTER,
            });
            island.add_child(label);

            const sync = () => (label.text = this._clock.clock);
            this._clock.connectObject('notify::clock', sync, island);
            sync();

            Main.layoutManager.addTopChrome(island, {trackFullscreen: false});

            this._addUnit({island, monitorIndex: monitor.index, isPrimary: false});
        }
    }

    /* Only the satellites are rebuilt when the monitor layout changes -- the
     * primary unit is the panel's own centre box and outlives any reshuffle. */
    _rebuildSatellites() {
        const keep = [];

        for (const unit of this._units ?? []) {
            if (unit.isPrimary) {
                keep.push(unit);
                continue;
            }

            this._cancelHideTimer(unit);
            unit.island.disconnectObject(unit.edge);
            Main.layoutManager.removeChrome(unit.edge);
            unit.edge.destroy();
            Main.layoutManager.removeChrome(unit.island);
            unit.island.destroy();
        }

        this._units = keep;
        this._clock = null;

        this._buildSatellites();
        this._styleIslands();
    }

    _addUnit({island, monitorIndex, isPrimary}) {
        const edge = new St.Widget({
            name: 'dynamicIslandRevealEdge',
            reactive: false,
            track_hover: true,
            /* Added hidden. The layout manager walks its chrome the moment the
             * actor joins it, and a visible actor with no allocation yet makes
             * it complain once per frame until the first layout pass. Hidden,
             * there is no stage view to update, and _placeUnit() shows it with
             * its geometry already set. */
            visible: false,
        });
        Main.layoutManager.addTopChrome(edge, {trackFullscreen: false});

        const unit = {island, edge, monitorIndex, isPrimary, revealed: true, hideTimer: 0};
        this._units.push(unit);

        /* The strip is added as top chrome, which would let it intercept clicks
         * on the island's topmost pixels. Tuck it underneath.
         *
         * The anchor is not the island itself for the primary unit: that island
         * is the panel's centre box, whose parent is the panel, not uiGroup --
         * and set_child_below_sibling() silently fails on a sibling that is not
         * a child of the container, leaving the strip on top of everything.
         * Its own chrome ancestor, panelBox, is the right anchor. A satellite
         * island is a uiGroup child in its own right. */
        Main.layoutManager.uiGroup.set_child_below_sibling(
            edge, isPrimary ? Main.layoutManager.panelBox : island);

        edge.connect('notify::hover', () => {
            if (edge.hover) {
                this._revealUnit(unit);
                /* While the island is tucked away the pointer rests on the
                 * strip, not on the island, so the expansion has to be armed
                 * from here as well -- and Clutter does not necessarily re-pick
                 * when the island slides in under a pointer that has not moved,
                 * so waiting for the island's own hover would never fire. */
                this._queueExpand(unit);
            } else {
                this._cancelExpandTimer();
                this._queueHideUnit(unit);
                this._queueCollapse();
            }
        });

        island.track_hover = true;
        island.connectObject('notify::hover', () => {
            if (island.hover) {
                this._revealUnit(unit);
                this._queueExpand(unit);
            } else {
                this._cancelExpandTimer();
                this._queueHideUnit(unit);
                this._queueCollapse();
            }
        }, edge);

        /* The island's width decides the strip's width, and it is still zero
         * before the first allocation. */
        island.connectObject('notify::width',
            () => this._placeUnit(unit), edge);

        /* Give it real geometry at once: the layout manager walks its chrome as
         * the actor is added, and a first pass with no allocation warns on
         * every frame until the next _placeUnits(). */
        this._placeUnit(unit);

        return unit;
    }

    _destroyUnits() {
        for (const unit of this._units ?? []) {
            this._cancelHideTimer(unit);

            unit.island.disconnectObject(unit.edge);
            Main.layoutManager.removeChrome(unit.edge);
            unit.edge.destroy();

            if (!unit.isPrimary) {
                Main.layoutManager.removeChrome(unit.island);
                unit.island.destroy();
            }
        }

        this._units = [];

        /* The satellites owned the clock's signals, so destroying them above
         * already severed them; dropping the reference is all that is left. */
        this._clock = null;
    }

    _monitorOf(unit) {
        return Main.layoutManager.monitors.find(m => m.index === unit.monitorIndex);
    }

    _placeUnits() {
        for (const unit of this._units ?? [])
            this._placeUnit(unit);
    }

    _placeUnit(unit) {
        const monitor = this._monitorOf(unit);
        if (!monitor)
            return;

        const height = this._settings.get_int('island-height');
        const gap = this._gap();

        /* A satellite island has no panel to live in, so it is positioned and
         * sized here. */
        if (!unit.isPrimary) {
            unit.island.set_height(height);
            const [, natWidth] = unit.island.get_preferred_width(height);
            unit.island.set_position(
                monitor.x + Math.round((monitor.width - natWidth) / 2),
                monitor.y + gap);
        }

        /* The strip spans the island, not the screen: the window buttons in the
         * top corners have to stay reachable.
         *
         * Measured on the COLLAPSED row, not the island's live width: the strip
         * only matters while the island is tucked away, and following the width
         * through the expansion would resize it on every frame -- which
         * invalidates its allocation each time and makes the layout manager
         * complain once per frame. */
        const base = unit.isPrimary
            ? this._topRow?.get_preferred_width(-1)[1] ?? unit.island.width
            : unit.island.width;
        const margin = this._settings.get_int('reveal-margin');
        const width = Math.round((base || 200) + 2 * margin);
        const edgeHeight = this._settings.get_int('reveal-edge');
        const x = monitor.x + Math.round((monitor.width - width) / 2);

        /* Only touch it when something actually changed. */
        if (unit.edge.width !== width || unit.edge.height !== edgeHeight)
            unit.edge.set_size(width, edgeHeight);
        if (unit.edge.x !== x || unit.edge.y !== monitor.y)
            unit.edge.set_position(x, monitor.y);

        unit.edge.show();
    }

    /* Opening the clock or the control centre moves the pointer off the island
     * and onto the menu, which would otherwise start the hide countdown and
     * pull the island away from under its own open menu. */
    _anyMenuOpen() {
        return this._expanded || ISLAND_ROLES.some(
            role => Main.panel.statusArea[role]?.menu?.isOpen);
    }

    _trackMenus() {
        for (const role of ISLAND_ROLES) {
            const menu = Main.panel.statusArea[role]?.menu;
            if (!menu)
                continue;

            this._connect(menu, 'open-state-changed', (_menu, isOpen) => {
                if (isOpen)
                    this._units.forEach(u => this._revealUnit(u));
                else
                    this._units.forEach(u => this._queueHideUnit(u));
            });
        }
    }

    /* Whether a given monitor's island should be out of the way. */
    _shouldAutoHide(unit) {
        const mode = this._settings.get_string('autohide-mode');
        if (mode === 'never' || Main.overview.visible)
            return false;

        const monitor = this._monitorOf(unit);
        if (!monitor)
            return false;

        if (monitor.inFullscreen)
            return true;

        if (mode !== 'fullscreen-and-maximized')
            return false;

        /* A maximized window covers the monitor exactly once the strut is gone,
         * but Mutter still does not call that fullscreen -- so ask the window.
         * Both axes, so a window tiled to one half does not count. */
        const window = global.display.focus_window;
        return !!window &&
            window.maximized_horizontally &&
            window.maximized_vertically &&
            window.get_monitor() === monitor.index;
    }

    /* Collapses a burst of state changes into one decision. */
    _queueSyncAutoHide() {
        if (this._autoHideTimer)
            GLib.Source.remove(this._autoHideTimer);

        this._autoHideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            AUTOHIDE_SETTLE_MS, () => {
                this._autoHideTimer = 0;
                this._syncAutoHide();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelSyncTimer() {
        if (this._autoHideTimer) {
            GLib.Source.remove(this._autoHideTimer);
            this._autoHideTimer = 0;
        }
    }

    _syncAutoHide() {
        if (!this._settings || !this._units)
            return;

        for (const unit of this._units) {
            const autoHide = this._shouldAutoHide(unit);

            /* The strip is armed only while hiding is in play, so it never
             * costs a click. The island, on the other hand, must always report
             * hover or the expansion could never arm while it is on screen.
             * Its own buttons stay reactive in their own right. */
            unit.edge.reactive = autoHide;
            unit.island.reactive = true;

            if (!autoHide) {
                this._cancelHideTimer(unit);
                this._revealUnit(unit);
                continue;
            }

            if (unit.edge.hover || unit.island.hover)
                this._revealUnit(unit);
            else
                this._hideUnit(unit);
        }
    }

    _revealUnit(unit) {
        this._cancelHideTimer(unit);
        if (unit.revealed)
            return;

        unit.revealed = true;
        this._animateUnit(unit, 0, 255);
    }

    _hideUnit(unit) {
        if (!unit.revealed || this._anyMenuOpen())
            return;

        unit.revealed = false;

        /* Slide up by its own height: Clutter's translation moves the actor for
         * picking as well as for drawing, so an island that is out of sight is
         * also out of reach.
         *
         * The travel comes from the settings rather than the live allocation,
         * which is still the previous value when hiding right after a style
         * change and left the island a couple of pixels short. */
        const offset = -(this._settings.get_int('island-height') + this._gap() + 6);
        this._animateUnit(unit, offset, 0);
    }

    /* Panel.vfunc_allocate() recomputes the island's x from its width every
     * frame and passes it through Math.ceil, so a fractional width makes x
     * oscillate by a pixel -- and the concave corners, which are placed from
     * that x and width, drift in and out of alignment with the pill's edge.
     * That seam opening and closing is the tremble.
     *
     * So the geometry is stepped by hand instead of eased: whole pixels only,
     * and a width whose parity matches the panel's, which makes
     * (panelWidth - islandWidth) / 2 land exactly on an integer.
     */
    _alignWidth(value) {
        const parity = Math.round(Main.panel.width) % 2;
        const width = Math.round(value);
        return ((width % 2) + 2) % 2 === parity ? width : width + 1;
    }

    _animateGeometry(fromWidth, toWidth, fromHeight, toHeight, duration, mode, onDone) {
        this._stopGeometry();

        const apply = progress => {
            const width = this._alignWidth(
                fromWidth + (toWidth - fromWidth) * progress);
            const height = Math.round(
                fromHeight + (toHeight - fromHeight) * progress);

            this._expandedBox.set_size(width, height);
            Main.panel.height = this._collapsedHeight() + height;
        };

        if (duration <= 0) {
            apply(1);
            onDone?.();
            return;
        }

        const timeline = new Clutter.Timeline({duration, actor: this._expandedBox});
        timeline.set_progress_mode(mode);

        timeline.connect('new-frame', () => apply(timeline.get_progress()));
        timeline.connect('stopped', () => {
            this._geometryTimeline = null;
            apply(1);
            onDone?.();
        });

        this._geometryTimeline = timeline;
        timeline.start();
    }

    _stopGeometry() {
        if (this._geometryTimeline) {
            const timeline = this._geometryTimeline;
            this._geometryTimeline = null;
            timeline.stop();
            timeline.run_dispose();
        }
    }

    _animateUnit(unit, translationY, opacity) {
        const duration = this._settings.get_int('animation-duration');

        unit.island.remove_all_transitions();
        unit.island.ease({
            translation_y: translationY,
            opacity,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        /* The corners are not children of the island, so they are eased with
         * it rather than carried by it. */
        if (unit.isPrimary) {
            for (const corner of this._corners ?? []) {
                corner.remove_all_transitions();
                corner.ease({
                    translation_y: translationY,
                    opacity,
                    duration,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        }
    }

    _queueHideUnit(unit) {
        this._cancelHideTimer(unit);
        if (!this._shouldAutoHide(unit) || this._anyMenuOpen())
            return;

        unit.hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('hide-delay'), () => {
                unit.hideTimer = 0;

                /* The pointer may have moved between the island and the strip,
                 * or a menu may have opened, while this was pending. */
                if (!unit.edge.hover && !unit.island.hover && !this._anyMenuOpen())
                    this._hideUnit(unit);

                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelHideTimer(unit) {
        if (unit?.hideTimer) {
            GLib.Source.remove(unit.hideTimer);
            unit.hideTimer = 0;
        }
    }

    _cancelAllHideTimers() {
        for (const unit of this._units ?? [])
            this._cancelHideTimer(unit);
    }

    _gap() {
        return this._settings.get_string('style') === 'floating'
            ? this._settings.get_int('top-gap')
            : 0;
    }

    /* One look for every island, the panel's own and the satellites alike. */
    _styleIslands() {
        const s = this._settings;
        const floating = s.get_string('style') === 'floating';
        const radius = s.get_int('corner-radius');
        const padding = s.get_int('side-padding');

        /* A notch is flush with the screen edge, so only its bottom corners are
         * rounded. A floating pill is rounded all round and sits below the edge. */
        const corners = floating ? `${radius}px` : `0 0 ${radius}px ${radius}px`;

        const style = [
            `background-color: rgba(0, 0, 0, ${s.get_double('bg-opacity').toFixed(3)});`,
            `border-radius: ${corners};`,
            `padding: 0 ${padding}px;`,
        ].join(' ');

        for (const unit of this._units ?? [])
            unit.island.set_style(style);
    }

    _applyBlur() {
        const centerBox = Main.panel._centerBox;
        const s = this._settings;

        centerBox.remove_effect_by_name(BLUR_EFFECT_NAME);
        if (!s.get_boolean('island-blur'))
            return;

        try {
            centerBox.add_effect_with_name(BLUR_EFFECT_NAME, new Shell.BlurEffect({
                name: BLUR_EFFECT_NAME,
                mode: Shell.BlurMode.BACKGROUND,
                radius: s.get_int('blur-radius'),
                brightness: s.get_double('blur-brightness'),
            }));
        } catch (e) {
            logError(e, 'dynamic-island: blur effect unavailable');
        }
    }

    _setStrut(enabled) {
        const panelBox = Main.layoutManager.panelBox;
        const index = Main.layoutManager._findActor(panelBox);
        if (index === -1)
            return;

        const data = Main.layoutManager._trackedActors[index];
        if (this._strutBackup === undefined)
            this._strutBackup = data.affectsStruts;

        /* Struts come from the actor's allocation, not its visibility
         * (layout.js:_updateRegions), so this flag is the only way to give the
         * reserved strip back to the windows. */
        data.affectsStruts = enabled ? this._strutBackup : false;
        Main.layoutManager._queueUpdateRegions();
    }

    _installVisibilityGuard() {
        const self = this;
        const proto = Main.layoutManager.constructor.prototype;

        this._injections.overrideMethod(proto, '_updateActorVisibility',
            orig => function (actorData) {
                if (self._isProtected(actorData?.actor))
                    return undefined;
                return orig.call(this, actorData);
            });
    }

    _isProtected(actor) {
        if (!actor || !this._settings)
            return false;

        switch (actor.name) {
        case PANEL_ACTOR_NAME:
            return this._settings.get_boolean('keep-in-fullscreen');
        case DOCK_ACTOR_NAME:
            return this._settings.get_boolean('fix-dock-fullscreen');
        default:
            return false;
        }
    }

    _syncProtectedVisibility() {
        for (const data of Main.layoutManager._trackedActors) {
            if (this._isProtected(data.actor))
                data.actor.show();
        }

        /* Re-evaluates every tracked actor through the guard above, so actors
         * that just stopped being protected are hidden again if they should be. */
        Main.layoutManager._updateVisibility();
    }

    _unguardDockFullscreen() {
        const ext = Main.extensionManager?.lookup(D2D_UUID);
        if (!ext?.path)
            return;

        Promise.all([
            import(`file://${ext.path}/autohide.js`),
            import(`file://${ext.path}/dock.js`),
        ]).then(([autohide, dock]) => {
            /* We may have been disabled while those imports resolved. */
            if (!this._injections)
                return;

            this._unguard(autohide?.AutoHide?.prototype, 'show',
                self => self.dock?._monitor);
            /* _checkOverlap() also returns "hide" outright on a fullscreen
             * monitor, before it ever looks at where the pointer is. Left
             * alone, a monitor that flickers into fullscreen slides the dock
             * out and back repeatedly. */
            this._unguard(autohide?.AutoHide?.prototype, '_checkOverlap',
                self => self.dock?._monitor);
            this._unguard(dock?.Dock?.prototype, '_onMotionEvent',
                self => self._monitor);
            this._unguard(dock?.Dock?.prototype, '_onEnterEvent',
                self => self._monitor);
        }).catch(e => {
            logError(e, 'dynamic-island: could not adapt dash2dock-lite');
        });
    }

    _unguard(proto, method, monitorOf) {
        if (typeof proto?.[method] !== 'function')
            return;

        this._injections.overrideMethod(proto, method, orig => function (...args) {
            const monitor = monitorOf(this);
            if (!monitor?.inFullscreen)
                return orig.call(this, ...args);

            Object.defineProperty(monitor, 'inFullscreen', {
                value: false,
                configurable: true,
            });
            try {
                return orig.call(this, ...args);
            } finally {
                /* Removing the own property uncovers the real getter again. */
                delete monitor.inFullscreen;
            }
        });
    }

    _trackFocusWindow() {
        this._untrackFocusWindow();

        const window = global.display.focus_window;
        if (!window)
            return;

        this._focusWindow = window;
        window.connectObject(
            'notify::maximized-horizontally', () => this._syncAutoHide(),
            'notify::maximized-vertically', () => this._syncAutoHide(),
            'notify::fullscreen', () => this._syncAutoHide(),
            'unmanaged', () => this._untrackFocusWindow(),
            this);
    }

    _untrackFocusWindow() {
        if (!this._focusWindow)
            return;

        try {
            this._focusWindow.disconnectObject(this);
        } catch (e) {
            /* The window may already be unmanaged. */
        }
        this._focusWindow = null;
    }

    /* ------------------------------------------------------------- expansion */

    /* The island does not spawn a panel beneath itself -- it becomes one. That
     * rules out a separate actor, because Panel.vfunc_allocate() pins the
     * centre box to the panel's height and would clip anything taller.
     *
     * So the panel's own height is what grows. The island's content is stacked
     * inside the centre box: a top row carrying the real clock and control
     * centre, and underneath it a box that is empty-sized when collapsed and
     * unfolds on hover. The centre box's natural width follows that content, and
     * vfunc_allocate() keeps it centred, so the pill widens and deepens as one
     * shape.
     */
    _buildIslandBody() {
        this._expanded = false;

        this._islandBody = new St.BoxLayout({
            name: 'dynamicIslandBody',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        /* Holds the reparented dateMenu and quickSettings. */
        this._topRow = new St.BoxLayout({name: 'dynamicIslandTopRow'});
        this._islandBody.add_child(this._topRow);

        this._expandedBox = new St.BoxLayout({
            name: 'dynamicIslandExpanded',
            orientation: Clutter.Orientation.VERTICAL,
            opacity: 0,
            visible: false,
        });
        /* Clipped so the unfolding content never spills past the pill while it
         * is still growing. */
        this._expandedBox.clip_to_allocation = true;
        this._islandBody.add_child(this._expandedBox);

        Main.panel._centerBox.add_child(this._islandBody);

        this._buildExpandedContent();
        this._buildTimerDot();
        this._buildCorners();
    }

    _buildExpandedContent() {
        const row = new St.BoxLayout({style_class: 'di-row'});
        this._mediaRow = row;
        this._expandedBox.add_child(row);

        this._cover = new St.Widget({style_class: 'di-cover'});
        row.add_child(this._cover);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'padding: 0 12px;',
        });
        row.add_child(text);

        this._title = new St.Label({style_class: 'di-title'});
        this._title.clutter_text.ellipsize = 3; /* Pango END */
        this._artist = new St.Label({style_class: 'di-artist'});
        this._artist.clutter_text.ellipsize = 3;
        text.add_child(this._title);
        text.add_child(this._artist);

        this._controls = new St.BoxLayout({
            style_class: 'di-controls',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this._controls);

        this._prevButton = this._islandButton('media-skip-backward-symbolic',
            () => this._player?.previous());
        this._playButton = this._islandButton('media-playback-start-symbolic',
            () => this._player?.playPause());
        this._nextButton = this._islandButton('media-skip-forward-symbolic',
            () => this._player?.next());

        this._emptyLabel = new St.Label({
            style_class: 'di-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._expandedBox.add_child(this._emptyLabel);

        this._buildTimer();
    }

    /* ----------------------------------------------------------- corners */

    /* The island meets the screen edge with a concave flare, the way the
     * notch does. border-radius only bends the other way, so each corner is a
     * small drawing area filled with Cairo: the square minus a quarter disc
     * centred on the corner that touches the island.
     *
     * They are separate chrome actors, so they have to be kept in step with the
     * island by hand -- its width is eased, and its position follows. */
    _buildCorners() {
        this._corners = [];

        for (const side of ['left', 'right']) {
            const corner = new St.DrawingArea({
                name: `dynamicIslandCorner-${side}`,
                reactive: false,
                /* Hidden until _placeCorners() has sized it, same reason as the
                 * reveal strip above. */
                visible: false,
            });
            corner._diSide = side;
            corner.connect('repaint', () => this._paintCorner(corner));

            Main.layoutManager.addTopChrome(corner, {trackFullscreen: false});
            /* Below the panel, like the reveal strip: never over the island. */
            Main.layoutManager.uiGroup.set_child_below_sibling(
                corner, Main.layoutManager.panelBox);

            this._corners.push(corner);
        }

        /* The island's allocation changes on every frame of the expansion, and
         * the corners have to ride along. */
        this._connect(Main.panel._centerBox, 'notify::allocation',
            () => this._placeCorners());

        /* Same reason as the reveal strip: real geometry before the layout
         * manager walks its chrome, or it warns on every frame until the first
         * _placeCorners(). */
        this._placeCorners();
    }

    _destroyCorners() {
        for (const corner of this._corners ?? []) {
            Main.layoutManager.removeChrome(corner);
            corner.destroy();
        }
        this._corners = [];
    }

    _placeCorners() {
        if (!this._corners?.length)
            return;

        const monitor = Main.layoutManager.primaryMonitor;
        const centerBox = Main.panel._centerBox;

        if (!monitor || !this._geom?.concave) {
            this._corners.forEach(c => c.hide());
            return;
        }

        const radius = this._geom.radius;
        const [islandX] = centerBox.get_transformed_position();
        const width = centerBox.width;

        for (const corner of this._corners) {
            /* Size and base position are set only when they really change.
             * Horizontal tracking goes through translation_x instead, because
             * a translation moves the actor without invalidating its
             * allocation -- set_position() every frame had the layout manager
             * warning on every frame of the expansion. */
            if (corner.width !== radius || corner.height !== radius) {
                corner.set_size(radius, radius);
                corner.queue_repaint();
            }
            if (corner.x !== 0 || corner.y !== monitor.y)
                corner.set_position(0, monitor.y);

            corner.translation_x = Math.round(corner._diSide === 'left'
                ? islandX - radius
                : islandX + width);
            /* Follows the island when it slides out of sight. */
            corner.translation_y = centerBox.translation_y;
            corner.opacity = centerBox.opacity;
            corner.show();
        }
    }

    _paintCorner(corner) {
        const cr = corner.get_context();
        const [w, h] = corner.get_surface_size();
        const opacity = this._geom?.opacity ?? this._settings.get_double('bg-opacity');

        cr.setSourceRGBA(0, 0, 0, opacity);

        if (corner._diSide === 'left') {
            /* Fill the square except a disc centred on its bottom-left corner,
             * which is the one touching the island. */
            cr.moveTo(0, 0);
            cr.lineTo(w, 0);
            cr.lineTo(w, h);
            cr.arcNegative(0, h, w, 0, -Math.PI / 2);
        } else {
            cr.moveTo(w, 0);
            cr.lineTo(0, 0);
            cr.lineTo(0, h);
            cr.arc(w, h, w, Math.PI, 1.5 * Math.PI);
        }

        cr.closePath();
        cr.fill();
        cr.$dispose();
    }

    /* ------------------------------------------------------------- timer */

    _buildTimer() {
        this._timerTick = 0;
        this._timerRunning = false;
        this._timerRemaining = this._focusSeconds();
        this._prevTotal = this._timerRemaining;

        const row = new St.BoxLayout({
            style_class: 'di-timer',
            x_expand: true,
        });
        this._expandedBox.add_child(row);

        /* The ring and its label share one cell: the ring is drawn, the time
         * sits on top of it. */
        const ringStack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: RING_SIZE,
            height: RING_SIZE,
            reactive: true,
        });
        row.add_child(ringStack);

        /* Fine adjustment: one minute per notch, straight on the ring. */
        ringStack.connect('scroll-event', (_actor, event) => {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP)
                this._changeDuration(+1);
            else if (direction === Clutter.ScrollDirection.DOWN)
                this._changeDuration(-1);
            else
                return Clutter.EVENT_PROPAGATE;

            return Clutter.EVENT_STOP;
        });

        this._ring = new St.DrawingArea({width: RING_SIZE, height: RING_SIZE});
        this._ring.connect('repaint', () => this._paintRing());
        ringStack.add_child(this._ring);

        this._timerLabel = new St.Label({
            style_class: 'di-timer-time',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        ringStack.add_child(this._timerLabel);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style: 'padding: 0 14px;',
        });
        row.add_child(text);

        this._timerState = new St.Label({style_class: 'di-timer-state', text: 'Focus'});
        text.add_child(this._timerState);

        /* The duration is set here rather than only in the preferences: the
         * buttons move by `duration-step`, a scroll on the ring by one minute. */
        const stepper = new St.BoxLayout({style_class: 'di-stepper'});
        text.add_child(stepper);

        this._minusButton = this._stepperButton('list-remove-symbolic', -1);
        this._timerHint = new St.Label({
            style_class: 'di-timer-hint',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._plusButton = this._stepperButton('list-add-symbolic', +1);

        stepper.add_child(this._minusButton);
        stepper.add_child(this._timerHint);
        stepper.add_child(this._plusButton);

        const buttons = new St.BoxLayout({
            style_class: 'di-controls',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(buttons);

        this._timerToggle = new St.Button({
            style_class: 'di-button di-button-accent',
            child: new St.Icon({icon_name: 'media-playback-start-symbolic', icon_size: 16}),
            can_focus: true,
        });
        this._timerToggle.connect('clicked', () => this._timerToggleRun());
        buttons.add_child(this._timerToggle);

        const reset = new St.Button({
            style_class: 'di-button',
            child: new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 16}),
            can_focus: true,
        });
        reset.connect('clicked', () => this._timerReset());
        buttons.add_child(reset);

        this._syncTimer();
    }

    _stepperButton(iconName, sign) {
        const button = new St.Button({
            style_class: 'di-step',
            child: new St.Icon({icon_name: iconName, icon_size: 11}),
            can_focus: true,
        });
        button.connect('clicked',
            () => this._changeDuration(sign * this._settings.get_int('duration-step')));
        return button;
    }

    /* Clamped by the schema's own range, so the island can never write a value
     * the settings would reject. */
    _changeDuration(deltaMinutes) {
        const key = this._settings.settings_schema.get_key('focus-duration');
        const [, range] = key.get_range().deepUnpack();
        const [min, max] = range.deepUnpack();

        const next = Math.max(min, Math.min(max,
            this._settings.get_int('focus-duration') + deltaMinutes));
        this._settings.set_int('focus-duration', next);
    }

    _onDurationChanged() {
        const total = this._focusSeconds();

        /* Idle: the new length becomes the session. Mid-session: keep what is
         * left, but never more than the session now lasts. */
        if (!this._timerRunning && this._timerRemaining >= this._prevTotal)
            this._timerRemaining = total;
        else
            this._timerRemaining = Math.min(this._timerRemaining, total);

        this._prevTotal = total;
        this._syncTimer();
    }

    _focusSeconds() {
        return this._settings.get_int('focus-duration') * 60;
    }

    /* A dot beside the clock, so a running session is visible while the island
     * is collapsed. Blue while it runs, amber while it is paused. */
    _buildTimerDot() {
        this._timerDot = new St.Widget({
            style_class: 'di-dot',
            width: DOT_SIZE,
            height: DOT_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._topRow.insert_child_at_index(this._timerDot, 0);
    }

    _timerToggleRun() {
        if (this._timerRunning) {
            this._timerStop();
        } else {
            if (this._timerRemaining <= 0)
                this._timerRemaining = this._focusSeconds();

            this._timerRunning = true;
            this._timerTick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._timerRemaining = Math.max(0, this._timerRemaining - 1);
                this._syncTimer();

                if (this._timerRemaining === 0) {
                    this._timerTick = 0;
                    this._timerRunning = false;
                    this._syncTimer();
                    Main.notify('Session de focus terminee',
                        `${this._settings.get_int('focus-duration')} minutes de focus.`);
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            });
        }

        this._syncTimer();
    }

    _timerStop() {
        this._timerRunning = false;
        if (this._timerTick) {
            GLib.Source.remove(this._timerTick);
            this._timerTick = 0;
        }
    }

    _timerReset() {
        this._timerStop();
        this._timerRemaining = this._focusSeconds();
        this._syncTimer();
    }

    /* One place that pushes the timer's state into every surface that shows it:
     * the ring, the time, the labels, the button icon and the collapsed dot. */
    _syncTimer() {
        if (!this._timerLabel)
            return;

        const total = this._focusSeconds();
        const left = Math.min(this._timerRemaining, total);
        const minutes = Math.floor(left / 60);
        const seconds = left % 60;

        this._timerLabel.text =
            `${minutes}:${seconds.toString().padStart(2, '0')}`;

        const idle = !this._timerRunning && left === total;
        this._timerState.text = this._timerRunning
            ? 'Focus'
            : (idle ? 'Focus' : 'En pause');
        this._timerHint.text = `${this._settings.get_int('focus-duration')} min`;

        /* Changing the length mid-session would be confusing, so the stepper is
         * live only while the timer is idle. */
        this._minusButton.reactive = idle;
        this._plusButton.reactive = idle;

        this._timerToggle.child.icon_name = this._timerRunning
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        if (this._timerDot) {
            this._timerDot.visible = !idle;
            this._timerDot.style = `background-color: ${
                this._timerRunning ? ACCENT_RUNNING : ACCENT_PAUSED};`;
        }

        this._ring?.queue_repaint();
    }

    /* A circle of dots rather than one continuous arc: each dot is worth the
     * session divided by their count, and goes out once its own share has
     * elapsed, clockwise from twelve o'clock. */
    _paintRing() {
        const cr = this._ring.get_context();

        const total = this._focusSeconds();
        const left = Math.min(this._timerRemaining, total);
        const elapsed = total > 0 ? 1 - left / total : 0;

        const count = this._settings.get_int('ring-dots');
        const spent = Math.floor(elapsed * count + 1e-9);

        const half = RING_SIZE / 2;
        const radius = half - RING_DOT_RADIUS - 2;
        const [r, g, b] = this._timerRunning ? RGB_RUNNING : RGB_PAUSED;

        for (let i = 0; i < count; i++) {
            const angle = -Math.PI / 2 + (i / count) * 2 * Math.PI;
            const x = half + radius * Math.cos(angle);
            const y = half + radius * Math.sin(angle);

            if (i < spent)
                cr.setSourceRGBA(1, 1, 1, 0.14); /* spent: out */
            else
                cr.setSourceRGBA(r, g, b, 1); /* still to come: lit */

            cr.arc(x, y, RING_DOT_RADIUS, 0, 2 * Math.PI);
            cr.fill();
        }

        cr.$dispose();
    }

    _islandButton(iconName, onClick) {

        const button = new St.Button({
            style_class: 'di-button',
            child: new St.Icon({icon_name: iconName, icon_size: 18}),
            can_focus: true,
        });
        button.connect('clicked', onClick);
        this._controls.add_child(button);
        return button;
    }

    _destroyIslandBody() {
        this._cancelCollapseTimer();
        this._stopGeometry();
        this._timerStop();
        this._cancelCoverFetch();
        this._coverUrl = null;
        this._destroyCorners();
        this._timerLabel = null;
        this._timerDot = null;
        this._ring = null;

        /* The indicators have to be out before this subtree goes, or they are
         * destroyed along with it. */
        if (this._islandBody) {
            Main.panel._centerBox.remove_child(this._islandBody);
            this._islandBody.destroy();
            this._islandBody = null;
        }

        this._topRow = null;
        this._expandedBox = null;
        this._expanded = false;
    }

    /* Collapsed height of the pill, which is also the panel's resting height. */
    _collapsedHeight() {
        return this._geom?.collapsedHeight ??
            this._settings.get_int('island-height') + this._gap();
    }

    _queueExpand(unit) {
        this._cancelExpandTimer();
        this._cancelCollapseTimer();

        if (!this._settings.get_boolean('expand-on-hover') || !unit.isPrimary)
            return;

        this._expandTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('expand-delay'), () => {
                this._expandTimer = 0;
                if (unit.island.hover || unit.edge.hover)
                    this._expand();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelExpandTimer() {
        if (this._expandTimer) {
            GLib.Source.remove(this._expandTimer);
            this._expandTimer = 0;
        }
    }

    _queueCollapse() {
        this._cancelCollapseTimer();
        if (!this._expanded)
            return;

        this._collapseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('hide-delay'), () => {
                this._collapseTimer = 0;
                const hovered = this._units.some(u => u.island.hover || u.edge.hover);
                if (!hovered)
                    this._collapse();
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelCollapseTimer() {
        if (this._collapseTimer) {
            GLib.Source.remove(this._collapseTimer);
            this._collapseTimer = 0;
        }
    }

    _expand() {
        if (!this._expandedBox || this._expanded)
            return;

        this._expanded = true;
        this._updateMedia();

        const duration = this._settings.get_int('animation-duration');
        const targetWidth = this._settings.get_int('shelf-width');

        /* Measure the unfolded content before it is on screen, so the growth has
         * a real target rather than a guess. */
        this._expandedBox.show();
        const [, naturalHeight] = this._expandedBox.get_preferred_height(targetWidth);
        const [, collapsedWidth] = this._topRow.get_preferred_width(-1);

        this._expandedBox.set_size(collapsedWidth, 0);

        /* The content fades in behind the growth, so nothing is drawn before
         * there is room for it. Opacity is safe to ease: it changes no layout. */
        this._expandedBox.remove_all_transitions();
        this._expandedBox.ease({
            opacity: 255,
            duration: Math.round(duration * 0.7),
            delay: Math.round(duration * 0.3),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        /* EASE_OUT_EXPO covered a quarter of the growth in its first frame --
         * measured at 98 px in one frame -- which read as a jolt rather than a
         * movement. Cubic ramps in gently and still settles softly. */
        this._animateGeometry(collapsedWidth, targetWidth, 0, naturalHeight,
            duration, Clutter.AnimationMode.EASE_OUT_CUBIC);
    }

    _collapse() {
        if (!this._expandedBox || !this._expanded)
            return;

        this._expanded = false;

        const duration = this._settings.get_int('animation-duration');

        const [, collapsedWidth] = this._topRow.get_preferred_width(-1);
        const fromWidth = this._expandedBox.width;
        const fromHeight = this._expandedBox.height;

        /* Faded out early: the content should be gone before the pill has
         * finished shrinking, not caught halfway. */
        this._expandedBox.remove_all_transitions();
        this._expandedBox.ease({
            opacity: 0,
            duration: Math.round(duration * 0.5),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        this._animateGeometry(fromWidth, collapsedWidth, fromHeight, 0,
            duration, Clutter.AnimationMode.EASE_IN_OUT_CUBIC, () => {
                this._expandedBox?.hide();
                /* Hand the sizing back to the top row so the pill settles on
                 * its natural collapsed width. */
                this._expandedBox?.set_size(-1, -1);
            });
    }

    /* ---------------------------------------------------------------- media */

    _setupMpris() {
        this._player = null;

        try {
            this._mprisSource = new Mpris.MprisSource();
        } catch (e) {
            logError(e, 'dynamic-island: MPRIS unavailable');
            this._mprisSource = null;
            return;
        }

        this._mprisSource.connectObject(
            'player-added', () => this._pickPlayer(),
            'player-removed', () => this._pickPlayer(),
            this);

        this._pickPlayer();
    }

    _teardownMpris() {
        this._bindPlayer(null);

        if (this._mprisSource) {
            this._mprisSource.disconnectObject(this);
            this._mprisSource = null;
        }
    }

    /* Prefer whatever is actually playing, else the first player that can. */
    _pickPlayer() {
        const players = this._mprisSource?.players ?? [];
        const playing = players.find(p => p.status === 'Playing');
        this._bindPlayer(playing ?? players[0] ?? null);
    }

    _bindPlayer(player) {
        if (this._player === player) {
            this._updateMedia();
            return;
        }

        this._player?.disconnectObject(this);
        this._player = player;
        this._player?.connectObject('changed', () => {
            /* A track change can also mean another player took over. */
            this._updateMedia();
        }, this);

        this._updateMedia();
    }

    _updateMedia() {
        if (!this._expandedBox)
            return;

        const player = this._player;
        const hasMedia = !!player;

        this._mediaRow.visible = hasMedia;
        this._emptyLabel.visible = !hasMedia;

        if (!hasMedia) {
            this._emptyLabel.text = 'Rien en lecture';
            return;
        }

        this._title.text = player.trackTitle || 'Titre inconnu';
        this._artist.text = (player.trackArtists ?? []).join(', ');

        const playing = player.status === 'Playing';
        this._playButton.child.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        this._prevButton.reactive = player.canGoPrevious;
        this._nextButton.reactive = player.canGoNext;

        this._setCover(player.trackCoverUrl);
    }

    /* St paints a background-image from a local file only, and Spotify hands
     * out an https URL (i.scdn.co). So a remote cover is fetched once into the
     * cache and painted from there; the next track that reuses it is instant. */
    _setCover(url) {
        if (this._coverUrl === url)
            return;

        this._coverUrl = url;
        this._cancelCoverFetch();

        if (!url) {
            this._cover.set_style(null);
            return;
        }

        if (url.startsWith('file://')) {
            this._cover.set_style(`background-image: url("${url}");`);
            return;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            this._cover.set_style(null);
            return;
        }

        const path = this._coverCachePath(url);
        const file = Gio.File.new_for_path(path);

        if (file.query_exists(null)) {
            this._cover.set_style(`background-image: url("file://${path}");`);
            return;
        }

        /* Nothing to show until it arrives. */
        this._cover.set_style(null);
        this._fetchCover(url, file);
    }

    _coverCachePath(url) {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), this.uuid]);
        const name = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256, url, -1);
        return GLib.build_filenamev([dir, name]);
    }

    _fetchCover(url, file) {
        try {
            GLib.mkdir_with_parents(file.get_parent().get_path(), 0o755);
        } catch (e) {
            logError(e, 'dynamic-island: could not create the cover cache');
            return;
        }

        this._coverSession ??= new Soup.Session();
        this._coverCancellable = new Gio.Cancellable();

        const cancellable = this._coverCancellable;
        const message = Soup.Message.new('GET', url);

        this._coverSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT,
            cancellable, (session, result) => {
                let bytes;
                try {
                    bytes = session.send_and_read_finish(result);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, `dynamic-island: cover download failed`);
                    return;
                }

                if (message.get_status() !== Soup.Status.OK || !bytes?.get_size())
                    return;

                /* Artwork is tens of kilobytes; anything far larger is not a
                 * cover and is not worth caching. */
                if (bytes.get_size() > COVER_MAX_BYTES)
                    return;

                file.replace_contents_bytes_async(bytes, null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable,
                    (target, writeResult) => {
                        try {
                            target.replace_contents_finish(writeResult);
                        } catch (e) {
                            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                                logError(e, 'dynamic-island: could not cache the cover');
                            return;
                        }

                        /* The track may have moved on while this was in flight. */
                        if (this._coverUrl !== url || !this._cover)
                            return;

                        this._cover.set_style(
                            `background-image: url("file://${target.get_path()}");`);
                    });
            });
    }

    _cancelCoverFetch() {
        if (this._coverCancellable) {
            this._coverCancellable.cancel();
            this._coverCancellable = null;
        }
    }

    /* --------------------------------------------- blur-my-shell conflict */

    _blurMyShellPanelSettings() {
        const ext = Main.extensionManager?.lookup(BMS_UUID);
        if (!ext?.path)
            return null;

        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                `${ext.path}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(BMS_PANEL_SCHEMA, true);
            return schema ? new Gio.Settings({settings_schema: schema}) : null;
        } catch (e) {
            return null;
        }
    }

    _suspendBlurMyShellPanel() {
        const bms = this._blurMyShellPanelSettings();
        if (!bms)
            return;

        if (bms.get_boolean('blur')) {
            this._bmsBlurBackup = true;
            bms.set_boolean('blur', false);
        }
    }

    _restoreBlurMyShellPanel() {
        if (!this._bmsBlurBackup)
            return;

        const bms = this._blurMyShellPanelSettings();
        bms?.set_boolean('blur', true);
        this._bmsBlurBackup = undefined;
    }

    /* ----------------------------------------------------------- indicators */

    _gatherIndicators() {
        const centerBox = this._topRow ?? Main.panel._centerBox;

        ISLAND_ROLES.forEach((role, position) => {
            const indicator = Main.panel.statusArea[role];
            if (!indicator)
                return;

            const container = indicator.container;
            const parent = container.get_parent();

            if (parent !== centerBox) {
                /* Remember the original box and index so disable() puts it back
                 * exactly where the shell had it. */
                if (parent && !this._origin.has(role)) {
                    this._origin.set(role, {
                        parent,
                        index: parent.get_children().indexOf(container),
                    });
                }
                parent?.remove_child(container);
                centerBox.insert_child_at_index(container, position);
            }

            container.show();
        });
    }

    _restoreIndicators() {
        for (const role of ISLAND_ROLES) {
            const indicator = Main.panel.statusArea[role];
            if (!indicator)
                continue;

            /* A saved parent box can already be finalised by now (session mode
             * churn, shutdown), and touching a dead GObject throws in GJS. */
            try {
                const container = indicator.container;
                const host = this._topRow ?? Main.panel._centerBox;
                if (container.get_parent() === host)
                    host.remove_child(container);

                const origin = this._origin.get(role);
                if (origin?.parent && !container.get_parent())
                    origin.parent.insert_child_at_index(container, origin.index);
            } catch (e) {
                logError(e, `dynamic-island: could not restore ${role}`);
            }
        }
    }
}
