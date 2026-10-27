/* Dynamic Island -- the system pane.
 *
 * Three rings (processor, memory, disk) and a throughput read-out, sampled from
 * /proc and from the filesystem. Every figure here is a rate or a ratio, so it
 * only means anything as a difference between two samples: the first tick after
 * the pane opens establishes the baseline and shows nothing, and the timer runs
 * only while the pane is visible -- a gauge nobody is looking at is pure cost.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const GAUGE_SIZE = 56;
const GAUGE_THICKNESS = 5;
const SAMPLE_MS = 1500;
const PRIME_MS = 250;

const METRICS = [
    {id: 'cpu', label: 'CPU', rgb: [0x6a / 255, 0xa9 / 255, 0xe0 / 255]},
    {id: 'ram', label: 'RAM', rgb: [0xb0 / 255, 0x8a / 255, 0xe0 / 255]},
    {id: 'disk', label: 'Disque', rgb: [0x5f / 255, 0xc9 / 255, 0xa8 / 255]},
];

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

function formatRate(bytesPerSecond) {
    if (!(bytesPerSecond > 0))
        return '0 o/s';

    const units = ['o/s', 'ko/s', 'Mo/s', 'Go/s'];
    let value = bytesPerSecond;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

class Gauge {
    constructor({label, rgb}) {
        this._rgb = rgb;
        this._fraction = 0;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            style_class: 'di-gauge',
        });

        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: GAUGE_SIZE,
            height: GAUGE_SIZE,
        });
        this.actor.add_child(stack);

        this._area = new St.DrawingArea({width: GAUGE_SIZE, height: GAUGE_SIZE});
        this._area.connect('repaint', () => this._paint());
        stack.add_child(this._area);

        this._value = new St.Label({
            style_class: 'di-gauge-value',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            text: '--',
        });
        stack.add_child(this._value);

        this._caption = new St.Label({
            style_class: 'di-gauge-caption',
            x_align: Clutter.ActorAlign.CENTER,
            text: label,
        });
        this.actor.add_child(this._caption);
    }

    /* `fraction` null means "not known yet", which is the honest state before
     * the second sample rather than a reading of zero. */
    set(fraction) {
        if (fraction === null) {
            this._fraction = 0;
            this._value.text = '--';
        } else {
            this._fraction = Math.min(1, Math.max(0, fraction));
            this._value.text = `${Math.round(this._fraction * 100)}`;
        }

        this._area.queue_repaint();
    }

    _paint() {
        const cr = this._area.get_context();
        const half = GAUGE_SIZE / 2;
        const radius = half - GAUGE_THICKNESS / 2 - 1;
        const [r, g, b] = this._rgb;

        cr.setLineWidth(GAUGE_THICKNESS);
        cr.setLineCap(1); /* Cairo.LineCap.ROUND */

        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.arc(half, half, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._fraction > 0) {
            const start = -Math.PI / 2;
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(half, half, radius, start, start + this._fraction * 2 * Math.PI);
            cr.stroke();
        }

        cr.$dispose();
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
        this._area = null;
    }
}

export class SystemPane {
    constructor() {
        this._timer = 0;
        this._primeTimer = 0;
        this._cpu = null;
        this._net = null;
        this._gauges = new Map();

        this.actor = new St.BoxLayout({
            style_class: 'di-system',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        for (const metric of METRICS) {
            const gauge = new Gauge(metric);
            this._gauges.set(metric.id, gauge);
            this.actor.add_child(gauge.actor);
        }

        const side = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'di-system-side',
        });
        this.actor.add_child(side);

        this._down = this._rateRow(side, 'go-down-symbolic');
        this._up = this._rateRow(side, 'go-up-symbolic');
        this._uptime = new St.Label({style_class: 'di-system-uptime', text: ''});
        side.add_child(this._uptime);
    }

    _rateRow(parent, iconName) {
        const row = new St.BoxLayout({style_class: 'di-system-rate'});
        row.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 11,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const label = new St.Label({
            text: '--',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(label);
        parent.add_child(row);
        return label;
    }

    start() {
        if (this._timer)
            return;

        /* Baseline first, then the real readings: a rate needs two points. */
        this._sample();

        /* The second point is taken quickly rather than on the normal cadence.
         * Processor load and throughput are differences, so the first sample
         * can only show a dash -- and a pane that opens on three dashes and
         * stays that way for a second and a half reads as broken. */
        this._primeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRIME_MS, () => {
            this._primeTimer = 0;
            this._sample();
            return GLib.SOURCE_REMOVE;
        });

        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAMPLE_MS, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }

        if (this._primeTimer) {
            GLib.Source.remove(this._primeTimer);
            this._primeTimer = 0;
        }

        /* Dropped so the next opening measures afresh rather than against a
         * baseline that may be minutes old. */
        this._cpu = null;
        this._net = null;
    }

    _sample() {
        this._gauges.get('cpu')?.set(this._sampleCpu());
        this._gauges.get('ram')?.set(this._sampleRam());
        this._gauges.get('disk')?.set(this._sampleDisk());
        this._sampleNet();
        this._sampleUptime();
    }

    _sampleCpu() {
        const stat = readFile('/proc/stat');
        if (!stat)
            return null;

        const line = stat.split('\n', 1)[0];
        const fields = line.split(/\s+/).slice(1).map(Number);
        if (fields.length < 5 || fields.some(Number.isNaN))
            return null;

        const total = fields.reduce((sum, value) => sum + value, 0);
        /* idle + iowait: time the processor had nothing to run. */
        const idle = fields[3] + fields[4];

        const previous = this._cpu;
        this._cpu = {total, idle};

        if (!previous)
            return null;

        const deltaTotal = total - previous.total;
        const deltaIdle = idle - previous.idle;
        if (deltaTotal <= 0)
            return null;

        return (deltaTotal - deltaIdle) / deltaTotal;
    }

    _sampleRam() {
        const meminfo = readFile('/proc/meminfo');
        if (!meminfo)
            return null;

        const value = key => {
            const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
            return match ? Number(match[1]) : null;
        };

        const total = value('MemTotal');
        /* MemAvailable, not MemFree: the kernel's own estimate of what a new
         * workload could claim, which is what "used" should mean here. */
        const available = value('MemAvailable');
        if (!total || available === null)
            return null;

        return (total - available) / total;
    }

    _sampleDisk() {
        try {
            const info = Gio.File.new_for_path('/').query_filesystem_info(
                'filesystem::size,filesystem::used', null);
            const size = info.get_attribute_uint64('filesystem::size');
            const used = info.get_attribute_uint64('filesystem::used');
            if (!size)
                return null;
            return used / size;
        } catch {
            return null;
        }
    }

    _sampleNet() {
        const dev = readFile('/proc/net/dev');
        if (!dev)
            return;

        let rx = 0;
        let tx = 0;

        for (const line of dev.split('\n').slice(2)) {
            const [name, rest] = line.split(':');
            if (!rest)
                continue;

            const iface = name.trim();
            /* Loopback and virtual bridges would count traffic that never left
             * the machine, and container interfaces double-count it. */
            if (iface === 'lo' || iface.startsWith('veth') ||
                iface.startsWith('docker') || iface.startsWith('br-'))
                continue;

            const fields = rest.trim().split(/\s+/).map(Number);
            rx += fields[0] || 0;
            tx += fields[8] || 0;
        }

        const now = GLib.get_monotonic_time();
        const previous = this._net;
        this._net = {rx, tx, now};

        if (!previous) {
            this._down.text = '--';
            this._up.text = '--';
            return;
        }

        const seconds = (now - previous.now) / 1e6;
        if (seconds <= 0)
            return;

        this._down.text = formatRate((rx - previous.rx) / seconds);
        this._up.text = formatRate((tx - previous.tx) / seconds);
    }

    _sampleUptime() {
        const uptime = readFile('/proc/uptime');
        if (!uptime) {
            this._uptime.text = '';
            return;
        }

        const seconds = Number(uptime.split(/\s+/)[0]);
        if (Number.isNaN(seconds)) {
            this._uptime.text = '';
            return;
        }

        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        this._uptime.text = days > 0
            ? `${days} j ${hours} h`
            : `${hours} h ${minutes} min`;
    }

    destroy() {
        this.stop();

        for (const gauge of this._gauges.values())
            gauge.destroy();
        this._gauges.clear();

        this.actor?.destroy();
        this.actor = null;
    }
}
