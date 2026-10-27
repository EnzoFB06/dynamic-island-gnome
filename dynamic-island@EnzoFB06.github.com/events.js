/* Dynamic Island -- events and their capsules.
 *
 * EventMonitor listens for the four things worth interrupting for and reports
 * them; capsule.js is what shows them.
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
            /* Carried so a click on the capsule can activate it, the way a
             * click on the shell's own banner does. */
            notification,
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
