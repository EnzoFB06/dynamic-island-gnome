/* Dynamic Island -- events and their capsules.
 *
 * Two halves. EventMonitor listens for the four things worth interrupting for;
 * EventCapsule is the short, wide shape the island takes while it says so.
 *
 * Every event carries its own motion rather than sharing one generic "something
 * happened" animation: a notification ripples outward, a charger fills a ring,
 * a Bluetooth device sends arcs, a finished timer throws its dots off the edge.
 * That is the point of the thing -- you should know what happened from the
 * corner of your eye, before reading a word of it.
 *
 * The monitor records the state it finds at startup and reports changes from
 * there, never the state itself: a laptop that is already charging when the
 * extension loads has not just been plugged in.
 */

import 'gi://GnomeBluetooth?version=3.0';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GnomeBluetooth from 'gi://GnomeBluetooth';
import St from 'gi://St';
import UPowerGlib from 'gi://UPowerGlib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';

export const EventKind = {
    NOTIFICATION: 'notification',
    CHARGING: 'charging',
    UNPLUGGED: 'unplugged',
    BLUETOOTH: 'bluetooth',
    TIMER: 'timer',
};

const GLYPH_SIZE = 46;
const GLYPH_MS = 1150;

const UPOWER_NAME = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';
const UPOWER_IFACE = 'org.freedesktop.UPower.Device';

/* Per kind: the tint of the drawn motion, and how the island itself arrives.
 * BACK overshoots and settles, which reads as a bounce; a timer that has just
 * run out gets no bounce -- it should feel like a full stop. */
const MOTIFS = {
    [EventKind.NOTIFICATION]: {
        rgb: [0x6a / 255, 0xa9 / 255, 0xe0 / 255],
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    },
    [EventKind.CHARGING]: {
        rgb: [0x6f / 255, 0xd0 / 255, 0x8c / 255],
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    },
    [EventKind.UNPLUGGED]: {
        rgb: [0xe8 / 255, 0xa4 / 255, 0x4c / 255],
        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
    },
    [EventKind.BLUETOOTH]: {
        rgb: [0x7a / 255, 0xa8 / 255, 0xf0 / 255],
        mode: Clutter.AnimationMode.EASE_OUT_BACK,
    },
    [EventKind.TIMER]: {
        rgb: [0x6a / 255, 0xa9 / 255, 0xe0 / 255],
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    },
};

export function motifFor(kind) {
    return MOTIFS[kind] ?? MOTIFS[EventKind.NOTIFICATION];
}

/* ------------------------------------------------------------------ monitor */

export class EventMonitor {
    constructor({onEvent, enabledFor}) {
        this._onEvent = onEvent;
        /* Asked per event rather than captured once, so toggling a kind in the
         * preferences takes effect without tearing the monitor down. */
        this._enabledFor = enabledFor ?? (() => true);

        this._trayIds = [];
        this._sources = new Map();
        this._btDevices = new Map();
        this._btClient = null;
        this._btStore = null;
        this._btStoreId = 0;
        this._power = null;
        this._powerId = 0;
        this._powerState = null;
        this._cancellable = null;
    }

    start() {
        this._watchNotifications();
        this._watchPower();
        this._watchBluetooth();
    }

    /* Called by the timer when a session runs out -- the one event that comes
     * from inside the island rather than from the system. */
    emitTimerDone(detail) {
        this._emit({
            kind: EventKind.TIMER,
            title: 'Session terminée',
            body: detail,
            iconName: 'alarm-symbolic',
        });
    }

    _emit(event) {
        if (!this._enabledFor(event.kind))
            return;

        /* Nothing takes over the island while the screen is locked or the
         * session is not showing its own UI. */
        if (Main.sessionMode.isLocked || Main.sessionMode.currentMode === 'unlockDialog')
            return;

        this._onEvent?.(event);
    }

    /* ------------------------------------------------------- notifications */

    _watchNotifications() {
        const tray = Main.messageTray;
        if (!tray)
            return;

        this._notifySettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });

        for (const source of tray.getSources())
            this._bindSource(source);

        this._trayIds.push(tray.connect('source-added',
            (_tray, source) => this._bindSource(source)));
        this._trayIds.push(tray.connect('source-removed',
            (_tray, source) => this._unbindSource(source)));
    }

    _bindSource(source) {
        if (this._sources.has(source))
            return;

        this._sources.set(source, source.connect('notification-request-banner',
            (_source, notification) => this._onNotification(source, notification)));
    }

    _unbindSource(source) {
        const id = this._sources.get(source);
        if (id) {
            source.disconnect(id);
            this._sources.delete(source);
        }
    }

    /* The capsule is a banner in all but name, so it shows exactly the set the
     * shell would have bannered -- the same three tests MessageTray applies to
     * this signal, no more. Reimplementing the judgement would mean a capsule
     * for a notification the shell deliberately stayed quiet about: a muted
     * application, a low-urgency background update, one already seen.
     *
     * Only a critical notification overrides the policy, which is how it
     * overrides Do Not Disturb everywhere else. */
    _onNotification(source, notification) {
        if (notification.acknowledged)
            return;

        if (notification.urgency === Urgency.LOW)
            return;

        if (notification.urgency !== Urgency.CRITICAL &&
            !(source.policy?.showBanners ??
              this._notifySettings?.get_boolean('show-banners') ?? true))
            return;

        this._emit({
            kind: EventKind.NOTIFICATION,
            title: notification.title || source.title || 'Notification',
            body: notification.body ?? '',
            gicon: notification.gicon ?? source.icon ?? null,
            iconName: 'preferences-system-notifications-symbolic',
        });
    }

    /* --------------------------------------------------------------- power */

    /* The shell's own battery indicator talks to UPower over a plain proxy
     * rather than through UPowerGlib's client, which does blocking work on
     * construction. Same choice here, and built asynchronously so nothing
     * stalls the compositor while the bus answers. */
    _watchPower() {
        this._cancellable = new Gio.Cancellable();

        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.NONE,
            null,
            UPOWER_NAME, UPOWER_PATH, UPOWER_IFACE,
            this._cancellable,
            (_source, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, 'dynamic-island: UPower unavailable');
                    return;
                }

                this._power = proxy;
                this._powerState = this._readPowerState();
                this._powerId = proxy.connect('g-properties-changed',
                    () => this._onPowerChanged());
            });
    }

    _readPowerState() {
        const state = this._power?.get_cached_property('State')?.unpack() ?? null;
        return state;
    }

    _percentage() {
        const value = this._power?.get_cached_property('Percentage')?.unpack();
        return typeof value === 'number' ? Math.round(value) : null;
    }

    _onPowerChanged() {
        const state = this._readPowerState();
        if (state === this._powerState)
            return;

        const previous = this._powerState;
        this._powerState = state;

        /* Only the crossing matters, and only in one direction at a time.
         * PENDING_CHARGE counts as plugged in: the cable is in, the battery is
         * simply not taking anything yet. */
        const charging = s => s === UPowerGlib.DeviceState.CHARGING ||
            s === UPowerGlib.DeviceState.PENDING_CHARGE ||
            s === UPowerGlib.DeviceState.FULLY_CHARGED;

        if (previous === null || charging(previous) === charging(state))
            return;

        const percentage = this._percentage();
        const detail = percentage === null ? '' : `${percentage} %`;

        if (charging(state)) {
            this._emit({
                kind: EventKind.CHARGING,
                title: 'Branché',
                body: detail,
                iconName: 'battery-full-charging-symbolic',
                fraction: percentage === null ? null : percentage / 100,
            });
        } else {
            this._emit({
                kind: EventKind.UNPLUGGED,
                title: 'Sur batterie',
                body: detail,
                iconName: 'battery-full-symbolic',
                fraction: percentage === null ? null : percentage / 100,
            });
        }
    }

    /* ----------------------------------------------------------- bluetooth */

    _watchBluetooth() {
        try {
            this._btClient = new GnomeBluetooth.Client();
        } catch (e) {
            logError(e, 'dynamic-island: Bluetooth unavailable');
            return;
        }

        this._btStore = this._btClient.get_devices();
        this._btStoreId = this._btStore.connect('items-changed',
            () => this._syncBluetooth());
        this._syncBluetooth();
    }

    /* The device list is a live model: pairing adds rows, powering the adapter
     * off empties it. Each row is bound once, and its state at binding time is
     * the baseline -- a headset already connected at startup is not news. */
    _syncBluetooth() {
        const seen = new Set();
        const count = this._btStore?.get_n_items() ?? 0;

        for (let i = 0; i < count; i++) {
            const device = this._btStore.get_item(i);
            if (!device)
                continue;

            seen.add(device);
            if (this._btDevices.has(device))
                continue;

            const id = device.connect('notify::connected',
                () => this._onBluetoothChanged(device));
            this._btDevices.set(device, id);
        }

        for (const [device, id] of [...this._btDevices]) {
            if (seen.has(device))
                continue;
            try {
                device.disconnect(id);
            } catch {
                /* Already finalised with the model. */
            }
            this._btDevices.delete(device);
        }
    }

    _onBluetoothChanged(device) {
        if (!device.connected)
            return;

        this._emit({
            kind: EventKind.BLUETOOTH,
            title: device.alias || device.name || 'Appareil Bluetooth',
            body: 'Connecté',
            iconName: device.icon || 'bluetooth-active-symbolic',
        });
    }

    /* ------------------------------------------------------------ teardown */

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;

        for (const id of this._trayIds)
            Main.messageTray?.disconnect(id);
        this._trayIds = [];

        for (const [source, id] of this._sources) {
            try {
                source.disconnect(id);
            } catch {
                /* Source already destroyed. */
            }
        }
        this._sources.clear();

        if (this._power && this._powerId) {
            this._power.disconnect(this._powerId);
            this._powerId = 0;
        }
        this._power = null;
        this._powerState = null;

        for (const [device, id] of this._btDevices) {
            try {
                device.disconnect(id);
            } catch {
                /* Device already finalised. */
            }
        }
        this._btDevices.clear();

        if (this._btStore && this._btStoreId) {
            this._btStore.disconnect(this._btStoreId);
            this._btStoreId = 0;
        }
        this._btStore = null;
        this._btClient = null;
        this._notifySettings = null;
    }
}

/* ------------------------------------------------------------------ capsule */

export class EventCapsule {
    constructor() {
        this._timeline = null;
        this._kind = null;
        this._fraction = null;
        this._dotCount = 8;

        this.actor = new St.BoxLayout({
            style_class: 'di-capsule',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: GLYPH_SIZE,
            height: GLYPH_SIZE,
        });
        this.actor.add_child(stack);

        this._glyph = new St.DrawingArea({width: GLYPH_SIZE, height: GLYPH_SIZE});
        this._glyph.connect('repaint', () => this._paint());
        stack.add_child(this._glyph);

        this._icon = new St.Icon({
            icon_size: 20,
            style_class: 'di-capsule-icon',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        /* Scaled about its middle for the entrance, not about its top-left
         * corner. Set through the setter rather than as a construct property:
         * pivot-point takes a Graphene.Point, and Clutter's own point type no
         * longer exists -- constructing one throws, here in the island's
         * builder, which would have taken the whole island down with it. */
        this._icon.set_pivot_point(0.5, 0.5);
        stack.add_child(this._icon);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'di-capsule-text',
        });
        this.actor.add_child(text);

        this._title = new St.Label({style_class: 'di-capsule-title'});
        this._title.clutter_text.ellipsize = 3; /* Pango END */
        this._body = new St.Label({style_class: 'di-capsule-body'});
        this._body.clutter_text.ellipsize = 3;
        text.add_child(this._title);
        text.add_child(this._body);
    }

    show(event, {ringDots = 8} = {}) {
        this._kind = event.kind;
        this._fraction = event.fraction ?? null;
        this._dotCount = ringDots;

        this._title.text = event.title ?? '';
        this._body.text = event.body ?? '';
        this._body.visible = !!event.body;

        if (event.gicon)
            this._icon.gicon = event.gicon;
        else
            this._icon.icon_name = event.iconName ?? 'dialog-information-symbolic';

        this.actor.show();
        this._runGlyph();
    }

    /* The icon lands with a small overshoot while the drawn motion plays behind
     * it. Two separate animations on purpose: the icon is an actor and eases,
     * the motion is painted and is driven by a timeline. */
    _runGlyph() {
        this._stopTimeline();

        this._icon.remove_all_transitions();
        this._icon.set_scale(0.55, 0.55);
        this._icon.opacity = 0;
        this._icon.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        const timeline = new Clutter.Timeline({
            duration: GLYPH_MS,
            actor: this._glyph,
        });
        timeline.connect('new-frame', () => this._glyph?.queue_repaint());
        timeline.connect('stopped', () => {
            this._timeline = null;
            this._glyph?.queue_repaint();
        });

        this._timeline = timeline;
        timeline.start();
    }

    _stopTimeline() {
        if (this._timeline) {
            const timeline = this._timeline;
            this._timeline = null;
            timeline.stop();
            timeline.run_dispose();
        }
    }

    hide() {
        this._stopTimeline();
        this.actor.hide();
        this._kind = null;
    }

    _paint() {
        const cr = this._glyph.get_context();
        const progress = this._timeline?.get_progress() ?? 1;
        const half = GLYPH_SIZE / 2;
        const [r, g, b] = motifFor(this._kind).rgb;

        switch (this._kind) {
        case EventKind.NOTIFICATION:
            this._paintRipples(cr, half, r, g, b, progress);
            break;
        case EventKind.BLUETOOTH:
            this._paintArcs(cr, half, r, g, b, progress);
            break;
        case EventKind.CHARGING:
            this._paintFill(cr, half, r, g, b, progress, true);
            break;
        case EventKind.UNPLUGGED:
            this._paintFill(cr, half, r, g, b, progress, false);
            break;
        case EventKind.TIMER:
            this._paintScatter(cr, half, r, g, b, progress);
            break;
        }

        cr.$dispose();
    }

    /* Two rings leaving the centre half a cycle apart, so there is always one
     * on its way out: a single ring reads as a glitch, two read as a pulse. */
    _paintRipples(cr, half, r, g, b, progress) {
        cr.setLineWidth(2);

        for (const offset of [0, 0.5]) {
            const phase = (progress + offset) % 1;
            const radius = 11 + phase * 11;
            const alpha = (1 - phase) * 0.55;

            cr.setSourceRGBA(r, g, b, alpha);
            cr.arc(half, half, radius, 0, 2 * Math.PI);
            cr.stroke();
        }
    }

    /* Three arcs on the right, lighting in sequence -- the shape every radio
     * indicator uses, which is why it needs no caption. */
    _paintArcs(cr, half, r, g, b, progress) {
        cr.setLineWidth(2.2);
        cr.setLineCap(1); /* ROUND */

        for (let i = 0; i < 3; i++) {
            const radius = 13 + i * 5;
            /* Each arc gets its own third of the run, then holds. */
            const phase = Math.min(1, Math.max(0, progress * 3 - i));
            if (phase <= 0)
                continue;

            cr.setSourceRGBA(r, g, b, 0.25 + phase * 0.55);
            cr.arc(half - 6, half, radius, -Math.PI / 4, Math.PI / 4);
            cr.stroke();
        }
    }

    /* A ring that fills to the charge level, clockwise from twelve. Draining
     * runs the other way, so plugging in and unplugging are opposite gestures
     * and not just opposite colours. */
    _paintFill(cr, half, r, g, b, progress, charging) {
        const radius = half - 4;
        const target = this._fraction ?? 1;
        const eased = charging ? progress : 1 - progress;
        const sweep = target * eased * 2 * Math.PI;

        cr.setLineWidth(3.5);
        cr.setLineCap(1);

        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.arc(half, half, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (sweep > 0.01) {
            const start = -Math.PI / 2;
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(half, half, radius, start, start + sweep);
            cr.stroke();
        }
    }

    /* The focus ring's dots, let go: they leave the circle outward and fade,
     * in two waves so the ring empties rather than vanishing. */
    _paintScatter(cr, half, r, g, b, progress) {
        const count = Math.max(4, this._dotCount);

        for (let wave = 0; wave < 2; wave++) {
            const phase = Math.min(1, Math.max(0, progress * 1.6 - wave * 0.25));
            if (phase <= 0)
                continue;

            const radius = 14 + phase * 9;
            const dotRadius = 3.2 * (1 - phase);
            const alpha = (1 - phase) * (wave === 0 ? 0.9 : 0.45);
            if (dotRadius <= 0.2)
                continue;

            cr.setSourceRGBA(r, g, b, alpha);

            for (let i = 0; i < count; i++) {
                const angle = -Math.PI / 2 +
                    (i / count) * 2 * Math.PI + wave * (Math.PI / count);
                cr.arc(half + radius * Math.cos(angle),
                    half + radius * Math.sin(angle), dotRadius, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }

    destroy() {
        this._stopTimeline();
        this.actor?.destroy();
        this.actor = null;
        this._glyph = null;
        this._icon = null;
    }
}
