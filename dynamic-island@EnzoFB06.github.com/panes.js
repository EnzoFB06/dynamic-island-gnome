/* Dynamic Island -- the pane deck.
 *
 * The expanded island shows one pane at a time and the wheel moves between
 * them. Panes are stacked in a BinLayout with a single visible child, which
 * matters for sizing: ClutterBinLayout skips invisible children when it
 * measures, so the deck's preferred height is the active pane's height alone
 * and the island can grow and shrink to fit whatever is on show.
 *
 * The deck does not animate its own height. It reports the change and the
 * extension drives the island's geometry, because the island's width, the
 * panel's height and the concave corners all have to move together -- the
 * island is one shape, and only one place can be in charge of it.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

const DOT_SIZE = 5;
const DOT_ACTIVE_WIDTH = 14;
const DOT_FADE_MS = 160;

export class PaneDeck {
    constructor({onChanged, fadeDuration = 120} = {}) {
        this._panes = [];
        this._activeId = null;
        /* A pane's onShow/onHide mean "you are on screen", not "you are
         * selected". The deck is only live while the island is unfolded, so the
         * system gauges do not sample and the search field does not hold a
         * keyboard grab just because that pane happens to be the current one in
         * a collapsed pill. */
        this._live = false;
        this._onChanged = onChanged;
        this._fadeDuration = fadeDuration;
        this._nameTimer = 0;

        this.actor = new St.BoxLayout({
            name: 'dynamicIslandPanes',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._deck = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        this.actor.add_child(this._deck);

        this._footer = new St.BoxLayout({
            style_class: 'di-pane-footer',
            x_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this.actor.add_child(this._footer);

        this._nameLabel = new St.Label({
            style_class: 'di-pane-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        /* An ellipsizing label reports a tiny preferred width -- Pango is
         * entitled to cut the text, so it asks for almost nothing and gets it.
         * "Systeme" came out as "Syste...". These names are two words at most;
         * let the label ask for the room it actually needs. */
        this._nameLabel.clutter_text.ellipsize = 0; /* Pango NONE */
        this._footer.add_child(this._nameLabel);

        this._dots = new St.BoxLayout({
            style_class: 'di-pane-dots',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._footer.add_child(this._dots);
    }

    /* A pane is {id, name, actor} plus optional onShow/onHide, called when it
     * becomes and stops being the visible one. Panes that poll (the system
     * gauges, the agents) use those to run only while they are on screen. */
    add(pane) {
        pane.actor.visible = false;
        pane.actor.x_expand = true;
        this._deck.add_child(pane.actor);

        pane.dot = new St.Widget({style_class: 'di-pane-dot'});
        pane.dot.set_size(DOT_SIZE, DOT_SIZE);
        this._dots.add_child(pane.dot);

        this._panes.push(pane);

        if (this._activeId === null)
            this.activate(pane.id, {animate: false});
        else
            this._syncDots();

        return pane;
    }

    /* Called when the island unfolds and when it closes. */
    setLive(live) {
        if (this._live === live)
            return;

        this._live = live;

        const pane = this.active;
        if (!pane)
            return;

        if (live)
            pane.onShow?.();
        else
            pane.onHide?.();
    }

    get live() {
        return this._live;
    }

    get panes() {
        return this._panes;
    }

    get activeId() {
        return this._activeId;
    }

    get active() {
        return this._panes.find(p => p.id === this._activeId) ?? null;
    }

    has(id) {
        return this._panes.some(p => p.id === id);
    }

    /* Natural height of what is on show, footer included. Measured rather than
     * assumed: each pane is a different shape, and the search pane changes
     * height as results come in. */
    preferredHeight(forWidth) {
        const [, height] = this.actor.get_preferred_height(forWidth);
        return height;
    }

    activate(id, {animate = true} = {}) {
        const next = this._panes.find(p => p.id === id);
        if (!next || id === this._activeId)
            return false;

        const previous = this.active;
        this._activeId = id;

        if (previous) {
            if (this._live)
                previous.onHide?.();
            previous.actor.remove_all_transitions();
            previous.actor.visible = false;
            previous.actor.opacity = 255;
        }

        next.actor.visible = true;
        if (this._live)
            next.onShow?.();

        /* The pane fades in on the spot while the island morphs around it. A
         * slide would have to be clipped against a box that is still resizing,
         * and the two motions read as one jolt rather than two. */
        if (animate) {
            next.actor.remove_all_transitions();
            next.actor.opacity = 0;
            next.actor.ease({
                opacity: 255,
                duration: this._fadeDuration,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            next.actor.opacity = 255;
        }

        this._syncDots();
        this._flashName();
        this._onChanged?.(next, previous);
        return true;
    }

    /* Wheel steps through the panes and stops at the ends rather than wrapping:
     * wrapping past the last pane feels like a mis-scroll, and there are few
     * enough panes that either end is one flick away. */
    cycle(delta) {
        const index = this._panes.findIndex(p => p.id === this._activeId);
        if (index < 0)
            return false;

        const target = Math.min(this._panes.length - 1, Math.max(0, index + delta));
        if (target === index)
            return false;

        return this.activate(this._panes[target].id);
    }

    _syncDots() {
        for (const pane of this._panes) {
            const isActive = pane.id === this._activeId;
            pane.dot.remove_all_transitions();
            pane.dot.ease({
                width: isActive ? DOT_ACTIVE_WIDTH : DOT_SIZE,
                duration: DOT_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            pane.dot.set_style(isActive
                ? 'background-color: rgba(255, 255, 255, 0.92);'
                : 'background-color: rgba(255, 255, 255, 0.28);');
        }
    }

    /* The name is there to tell you where you are just after a switch, then
     * gets out of the way -- the dots alone carry the position afterwards. */
    _flashName() {
        const pane = this.active;
        if (!pane)
            return;

        this._nameLabel.text = pane.name;
        this._nameLabel.remove_all_transitions();
        this._nameLabel.opacity = 255;

        this._cancelNameTimer();
        this._nameTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1400, () => {
            this._nameTimer = 0;
            this._nameLabel?.ease({
                opacity: 90,
                duration: 400,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelNameTimer() {
        if (this._nameTimer) {
            GLib.Source.remove(this._nameTimer);
            this._nameTimer = 0;
        }
    }

    destroy() {
        this._cancelNameTimer();

        for (const pane of this._panes) {
            if (this._live)
                pane.onHide?.();
            pane.onDestroy?.();
        }
        this._live = false;
        this._panes = [];

        this.actor?.destroy();
        this.actor = null;
        this._deck = null;
        this._footer = null;
        this._dots = null;
        this._nameLabel = null;
    }
}
