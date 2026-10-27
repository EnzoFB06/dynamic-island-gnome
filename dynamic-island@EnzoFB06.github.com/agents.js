/* Dynamic Island -- the Claude agents pane.
 *
 * One robot per running agent. The extension cannot see inside Claude Code, so
 * Claude Code reports to it: the shipped hook (tools/di-agent-hook) writes one
 * small JSON file per session into a state directory, and this watches that
 * directory. No polling of processes, no guessing from log files -- the session
 * says what it is doing, as it does it.
 *
 * Every robot is drawn rather than assembled from icons, because the state is
 * the pose: a working agent bobs and its eyes scan, one waiting on you holds
 * still with its eyes wide, and one that has finished tilts its head with its
 * eyes shut. You should be able to tell which is which across the room, at
 * fifteen pixels, without reading the label.
 *
 * All the robots share one timeline. A dozen actors each running their own
 * would each wake the compositor on their own schedule; one clock at 25 frames
 * a second drives every robot on screen and stops the moment none of them has
 * anything to say.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

/* Design space for the drawing, scaled to whatever size is asked for, so the
 * 15 px robot in the collapsed pill and the 30 px one in the pane are the same
 * robot. */
const ART_WIDTH = 30;
const ART_HEIGHT = 34;

const CYCLE_MS = 1800;
const FRAME_MS = 40; /* 25 fps: a bobbing head needs no more */

const RESCAN_DEBOUNCE_MS = 150;

/* A working session writes on every tool call. An hour of silence means the
 * process is gone, not that it is thinking. Finished sessions are kept far
 * longer -- they are alive and idle, and their file is removed when the session
 * actually ends. */
const STALE_ACTIVE_S = 3600;
const STALE_IDLE_S = 12 * 3600;

const CORAL = [0xd9 / 255, 0x77 / 255, 0x57 / 255];
const FACE = [0x2a / 255, 0x17 / 255, 0x10 / 255];

const STATE_LIGHT = {
    running: [1, 1, 1],
    waiting: [0xe8 / 255, 0xa4 / 255, 0x4c / 255],
    done: [0x6f / 255, 0xd0 / 255, 0x8c / 255],
    idle: [1, 1, 1],
};

const STATE_TEXT = {
    running: 'au travail',
    waiting: 'attend une réponse',
    done: 'terminé',
    idle: 'en veille',
};

const ORDER = {running: 0, waiting: 1, done: 2, idle: 3};

export function agentStateDir() {
    const runtime = GLib.getenv('XDG_RUNTIME_DIR');
    const base = runtime || GLib.build_filenamev([GLib.get_home_dir(), '.cache']);
    return GLib.build_filenamev([base, 'dynamic-island', 'agents']);
}

/* ------------------------------------------------------------------- clock */

const clock = {
    _timeline: null,
    _users: new Set(),
    _lastFrame: 0,
    phase: 0,

    subscribe(fn) {
        this._users.add(fn);
        this._sync();
    },

    unsubscribe(fn) {
        this._users.delete(fn);
        this._sync();
    },

    _sync() {
        if (this._users.size > 0 && !this._timeline) {
            const timeline = new Clutter.Timeline({
                duration: CYCLE_MS,
                repeat_count: -1,
            });
            timeline.connect('new-frame', () => this._frame(timeline));
            this._timeline = timeline;
            timeline.start();
        } else if (this._users.size === 0 && this._timeline) {
            const timeline = this._timeline;
            this._timeline = null;
            timeline.stop();
            timeline.run_dispose();
            this.phase = 0;
        }
    },

    _frame(timeline) {
        const now = GLib.get_monotonic_time();
        if (now - this._lastFrame < FRAME_MS * 1000)
            return;

        this._lastFrame = now;
        this.phase = timeline.get_progress();

        for (const fn of [...this._users])
            fn(this.phase);
    },
};

/* ------------------------------------------------------------------- robot */

function roundedRect(cr, x, y, width, height, radius) {
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export class Robot {
    constructor(size = 30) {
        this._state = 'idle';
        this._size = size;
        this._height = Math.round(size * ART_HEIGHT / ART_WIDTH);

        this.actor = new St.DrawingArea({
            width: size,
            height: this._height,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.connect('repaint', () => this._paint());
    }

    get animated() {
        return this._state === 'running' || this._state === 'waiting';
    }

    setState(state) {
        if (this._state === state)
            return;

        this._state = state;
        this.actor?.queue_repaint();
    }

    /* Called from the shared clock, not from a transition of its own. */
    tick() {
        this.actor?.queue_repaint();
    }

    _paint() {
        const cr = this.actor.get_context();
        const phase = clock.phase;
        const state = this._state;

        cr.save();
        cr.scale(this._size / ART_WIDTH, this._height / ART_HEIGHT);

        /* A working robot bobs; one waiting on you is deliberately still, which
         * is what makes it read as waiting rather than as stopped. */
        const bob = state === 'running' ? Math.sin(phase * 2 * Math.PI) * 1.4 : 0;
        cr.translate(0, bob);

        /* The finished pose: head tipped, the way you put something down. */
        if (state === 'done') {
            cr.translate(ART_WIDTH / 2, ART_HEIGHT * 0.6);
            cr.rotate(-0.16);
            cr.translate(-ART_WIDTH / 2, -ART_HEIGHT * 0.6);
        }

        const dim = state === 'idle' ? 0.5 : 1;
        const [lr, lg, lb] = STATE_LIGHT[state] ?? STATE_LIGHT.idle;

        /* antenna */
        cr.setLineWidth(1.6);
        cr.setSourceRGBA(CORAL[0], CORAL[1], CORAL[2], dim);
        cr.moveTo(ART_WIDTH / 2, 9);
        cr.lineTo(ART_WIDTH / 2, 4);
        cr.stroke();

        /* Its light is the status lamp: it breathes while working, blinks
         * slowly while waiting, and sits steady once there is nothing to do. */
        let lampRadius = 2;
        let lampAlpha = dim;
        if (state === 'running') {
            lampRadius = 1.8 + 0.9 * (0.5 + 0.5 * Math.sin(phase * 4 * Math.PI));
        } else if (state === 'waiting') {
            lampAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(phase * 2 * Math.PI));
            lampRadius = 2.3;
        }

        cr.setSourceRGBA(lr, lg, lb, lampAlpha);
        cr.arc(ART_WIDTH / 2, 3, lampRadius, 0, 2 * Math.PI);
        cr.fill();

        /* head */
        cr.setSourceRGBA(CORAL[0], CORAL[1], CORAL[2], dim);
        roundedRect(cr, 3.5, 9, ART_WIDTH - 7, 19, 6);
        cr.fill();

        /* eyes */
        const eyeY = 18.5;
        const scan = state === 'running'
            ? Math.sin(phase * 2 * Math.PI) * 1.3
            : 0;

        cr.setSourceRGBA(FACE[0], FACE[1], FACE[2], dim);

        if (state === 'done') {
            /* Shut and curved upward. Two short arcs, drawn as the bottom half
             * of a circle, which is the whole of the expression. */
            cr.setLineWidth(1.6);
            for (const x of [10.5, 19.5]) {
                cr.newSubPath();
                cr.arc(x, eyeY - 0.5, 2.3, Math.PI * 0.15, Math.PI * 0.85);
                cr.stroke();
            }
        } else {
            const radius = state === 'waiting' ? 2.9 : (state === 'idle' ? 1.7 : 2.4);
            for (const x of [10.5, 19.5]) {
                cr.arc(x + scan, eyeY, radius, 0, 2 * Math.PI);
                cr.fill();
            }
        }

        cr.restore();
        cr.$dispose();
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
    }
}

/* ----------------------------------------------------------------- watcher */

export class AgentWatcher {
    constructor({onChanged}) {
        this._onChanged = onChanged;
        this._monitor = null;
        this._debounce = 0;
        this.agents = [];
        this.dirExists = false;
    }

    start() {
        const dir = Gio.File.new_for_path(agentStateDir());

        try {
            /* Watched even if it does not exist yet: installing the hook later
             * creates it, and the monitor reports that as a change. */
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', () => this._queueRescan());
        } catch (e) {
            logError(e, 'dynamic-island: cannot watch the agent state directory');
        }

        this.rescan();
    }

    _queueRescan() {
        /* A single hook writes a temporary file and renames it, which is two
         * events; several sessions working at once make that a burst. */
        if (this._debounce)
            GLib.Source.remove(this._debounce);

        this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            RESCAN_DEBOUNCE_MS, () => {
                this._debounce = 0;
                this.rescan();
                return GLib.SOURCE_REMOVE;
            });
    }

    rescan() {
        const path = agentStateDir();
        const dir = Gio.File.new_for_path(path);
        const agents = [];

        this.dirExists = dir.query_exists(null);

        if (this.dirExists) {
            let children = null;
            try {
                children = dir.enumerate_children('standard::name',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                children = null;
            }

            const now = GLib.get_real_time() / 1e6;

            let info;
            while (children && (info = children.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.endsWith('.json'))
                    continue;

                const agent = this._read(GLib.build_filenamev([path, name]));
                if (!agent)
                    continue;

                /* A session killed outright never reports again, so the file is
                 * all that is left of it. Age it out rather than drawing a
                 * robot that will never move. */
                const age = now - agent.updated;
                const limit = (agent.state === 'running' || agent.state === 'waiting')
                    ? STALE_ACTIVE_S
                    : STALE_IDLE_S;
                if (agent.updated > 0 && age > limit)
                    continue;

                agents.push(agent);
            }
        }

        /* Working agents first: they are the ones you opened the island for. */
        agents.sort((a, b) => {
            const rank = (ORDER[a.state] ?? 9) - (ORDER[b.state] ?? 9);
            return rank !== 0 ? rank : a.label.localeCompare(b.label);
        });

        this.agents = agents;
        this._onChanged?.(agents);
    }

    _read(path) {
        let text;
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                return null;
            text = new TextDecoder().decode(bytes);
        } catch {
            return null;
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch {
            /* A write caught half way, or something else's file. */
            return null;
        }

        if (!data || typeof data !== 'object')
            return null;

        const state = ['running', 'waiting', 'done', 'idle'].includes(data.state)
            ? data.state
            : 'idle';

        return {
            id: String(data.session_id ?? path),
            label: String(data.label ?? 'claude'),
            state,
            tool: String(data.tool ?? ''),
            subagents: Number.isFinite(data.subagents) ? data.subagents : 0,
            updated: Number.isFinite(data.updated) ? data.updated : 0,
        };
    }

    get activeCount() {
        return this.agents.filter(a => a.state === 'running' || a.state === 'waiting').length;
    }

    stop() {
        if (this._debounce) {
            GLib.Source.remove(this._debounce);
            this._debounce = 0;
        }

        this._monitor?.cancel();
        this._monitor = null;
        this.agents = [];
    }
}

/* -------------------------------------------------------------------- views */

/* Shared by the pane and the collapsed strip: both keep a set of robots keyed
 * by session, and both want the clock only while one of their robots moves. */
class RobotSet {
    constructor(size) {
        this._size = size;
        this._robots = new Map();
        this._tick = phase => this._onTick(phase);
        this._subscribed = false;
    }

    _onTick() {
        for (const robot of this._robots.values()) {
            if (robot.animated)
                robot.tick();
        }
    }

    /* Returns the robot for a session, creating it on first sight. The actor is
     * reused across rescans so a robot that is already mid-bob keeps bobbing
     * rather than restarting every time a file is touched. */
    robotFor(id) {
        let robot = this._robots.get(id);
        if (!robot) {
            robot = new Robot(this._size);
            this._robots.set(id, robot);
        }
        return robot;
    }

    prune(keep) {
        for (const [id, robot] of [...this._robots]) {
            if (keep.has(id))
                continue;
            robot.destroy();
            this._robots.delete(id);
        }
    }

    syncClock(wanted) {
        const animating = wanted &&
            [...this._robots.values()].some(robot => robot.animated);

        if (animating && !this._subscribed) {
            clock.subscribe(this._tick);
            this._subscribed = true;
        } else if (!animating && this._subscribed) {
            clock.unsubscribe(this._tick);
            this._subscribed = false;
        }
    }

    destroy() {
        if (this._subscribed) {
            clock.unsubscribe(this._tick);
            this._subscribed = false;
        }

        for (const robot of this._robots.values())
            robot.destroy();
        this._robots.clear();
    }
}

const PANE_ROBOT_SIZE = 28;
const PANE_MAX_ROWS = 4;

export class AgentsPane {
    constructor({onHeightChange} = {}) {
        this._onHeightChange = onHeightChange;
        this._visible = false;
        this._set = new RobotSet(PANE_ROBOT_SIZE);
        this._rows = new Map();

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'di-agents',
            x_expand: true,
        });

        this._list = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'di-agent-list',
        });
        this.actor.add_child(this._list);

        this._empty = new St.Label({
            style_class: 'di-empty',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._empty);

        this._more = new St.Label({
            style_class: 'di-agent-more',
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.actor.add_child(this._more);
    }

    setVisible(visible) {
        this._visible = visible;
        this._set.syncClock(visible);
    }

    update(agents, {hookInstalled = true} = {}) {
        const shown = agents.slice(0, PANE_MAX_ROWS);
        const keep = new Set(shown.map(a => a.id));
        const before = this._rows.size;

        for (const [id, row] of [...this._rows]) {
            if (keep.has(id))
                continue;
            row.destroy();
            this._rows.delete(id);
        }
        this._set.prune(keep);

        for (const agent of shown)
            this._syncRow(agent);

        /* Rebuilt in order each time: the sort puts working agents first, and a
         * row that changes state has to move with it. */
        for (const agent of shown) {
            const row = this._rows.get(agent.id);
            this._list.set_child_at_index(row, shown.indexOf(agent));
        }

        this._empty.visible = agents.length === 0;
        this._empty.text = hookInstalled
            ? 'Aucun agent en cours'
            : 'Hook non installé (make install-hooks)';

        const hidden = agents.length - shown.length;
        this._more.visible = hidden > 0;
        this._more.text = hidden > 0 ? `+ ${hidden} autre${hidden > 1 ? 's' : ''}` : '';

        this._set.syncClock(this._visible);

        if (this._rows.size !== before)
            this._onHeightChange?.();
    }

    _syncRow(agent) {
        let row = this._rows.get(agent.id);

        if (!row) {
            row = new St.BoxLayout({style_class: 'di-agent-row', x_expand: true});

            const robot = this._set.robotFor(agent.id);
            row.add_child(robot.actor);

            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            row.add_child(text);

            row._diName = new St.Label({style_class: 'di-agent-name'});
            row._diName.clutter_text.ellipsize = 3; /* Pango END */
            row._diState = new St.Label({style_class: 'di-agent-state'});
            row._diState.clutter_text.ellipsize = 3;
            text.add_child(row._diName);
            text.add_child(row._diState);

            row._diBadge = new St.Label({
                style_class: 'di-agent-badge',
                y_align: Clutter.ActorAlign.CENTER,
                visible: false,
            });
            row.add_child(row._diBadge);

            this._list.add_child(row);
            this._rows.set(agent.id, row);
        }

        this._set.robotFor(agent.id).setState(agent.state);

        row._diName.text = agent.label;
        row._diState.text = agent.tool
            ? `${STATE_TEXT[agent.state]} · ${agent.tool}`
            : STATE_TEXT[agent.state];

        row._diBadge.visible = agent.subagents > 0;
        row._diBadge.text = agent.subagents > 0 ? `+${agent.subagents}` : '';
    }

    destroy() {
        this._set.destroy();
        for (const row of this._rows.values())
            row.destroy();
        this._rows.clear();

        this.actor?.destroy();
        this.actor = null;
    }
}

const STRIP_ROBOT_SIZE = 15;
const STRIP_MAX = 3;

/* The collapsed pill's share of this: up to three small robots beside the
 * clock, so an agent working in the background is visible without opening
 * anything. */
export class AgentStrip {
    constructor() {
        this._set = new RobotSet(STRIP_ROBOT_SIZE);
        this._shown = [];

        this.actor = new St.BoxLayout({
            style_class: 'di-agent-strip',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
    }

    update(agents) {
        /* Finished agents are not interesting at this size -- the pill would
         * carry a robot for every session left open all day. */
        const active = agents.filter(a => a.state === 'running' || a.state === 'waiting');
        const shown = active.slice(0, STRIP_MAX);
        const keep = new Set(shown.map(a => a.id));

        for (const id of this._shown) {
            if (keep.has(id))
                continue;
            const robot = this._set.robotFor(id);
            this.actor.remove_child(robot.actor);
        }
        this._set.prune(keep);

        this._shown = shown.map(a => a.id);

        for (const [index, agent] of shown.entries()) {
            const robot = this._set.robotFor(agent.id);
            robot.setState(agent.state);

            if (robot.actor.get_parent() !== this.actor)
                this.actor.add_child(robot.actor);
            this.actor.set_child_at_index(robot.actor, index);
        }

        this.actor.visible = shown.length > 0;
        this._set.syncClock(shown.length > 0);
    }

    destroy() {
        this._set.destroy();
        this.actor?.destroy();
        this.actor = null;
    }
}
