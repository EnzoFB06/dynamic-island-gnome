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

/* How far the arriving pane travels. Translation, not layout: it moves the
 * actor for drawing without changing what it asks for, so the island can be
 * measuring and morphing its height at the same time without the two fighting.
 * Enough to read as a direction, not so much that the pane appears to come
 * from outside the island. */
const SLIDE_PX = 22;

export class PaneDeck {
    constructor({onChanged, fadeDuration = 220} = {}) {
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

        /* The wheel turns one way or the other, and the pane arrives from the
         * side the wheel came from: scrolling down brings the next pane up from
         * below. Without that, every switch looks the same and the deck gives
         * no sense of where you are in it. */
        const from = this._panes.indexOf(previous);
        const to = this._panes.indexOf(next);
        const direction = from < 0 || to > from ? 1 : -1;

        this._activeId = id;

        if (previous) {
            if (this._live)
                previous.onHide?.();
            previous.actor.remove_all_transitions();
            /* Taken off screen at once rather than faded out. The deck measures
             * itself from its visible children -- BinLayout skips the rest --
             * and the island reads that height the moment this call returns, so
             * a pane lingering on its way out would be measured as if it had
             * stayed and the island would morph to the wrong size. */
            previous.actor.visible = false;
            previous.actor.opacity = 255;
            previous.actor.translation_y = 0;
        }

        next.actor.visible = true;
        if (this._live)
            next.onShow?.();

        /* The arriving pane rises into place as it fades in, while the island
         * morphs its height around it. Both are eased out, so they settle
         * together rather than one landing before the other. */
        if (animate) {
            next.actor.remove_all_transitions();
            next.actor.opacity = 0;
            next.actor.translation_y = direction * SLIDE_PX;
            next.actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: this._fadeDuration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            next.actor.opacity = 255;
            next.actor.translation_y = 0;
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
