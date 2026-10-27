/* Dynamic Island -- the detached capsule.
 *
 * An event does not deform the island any more; it gets a pill of its own,
 * floating below the top edge. That is what lets a notification show up while
 * the island itself is tucked away over a fullscreen window: the two are
 * separate chrome actors, and only one of them is hiding.
 *
 * Three acts, after ActivSpot's notification island:
 *
 *   full      a wide pill with the icon, the title and the body, held long
 *             enough to read
 *   compact   it draws in to a small pill carrying the icon and one line, and
 *             lingers there -- the part you catch out of the corner of your eye
 *             after you have stopped reading
 *   away      it lifts, shrinks and fades
 *
 * The geometry is stepped by hand rather than eased, for the same reason the
 * island's is: the pill is centred, so its x is a function of its width, and
 * easing width and position as two separate transitions lets them disagree by a
 * pixel on every frame. One timeline computes both.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EventKind, motifFor} from './events.js';

export const CAPSULE_ACTOR_NAME = 'dynamicIslandCapsule';

const BLUR_EFFECT_NAME = 'dynamic-island-capsule-blur';

/* ActivSpot moves its island with a 540 ms OutExpo and fades at 200 ms
 * OutCubic, and that pairing is most of why the thing feels like hardware
 * rather than like a widget: the shape arrives well before the content does. */
const MORPH_MS = 480;
const FADE_MS = 200;
const AWAY_MS = 300;

const FULL_WIDTH = 400;
const FULL_PADDING = 14;
const COMPACT_HEIGHT = 36;
const COMPACT_MAX_WIDTH = 280;

const GLYPH_SIZE = 46;
const GLYPH_MS = 1150;

const Phase = {
    FULL: 'full',
    COMPACT: 'compact',
};

export class DetachedCapsule {
    constructor({settings, onDone}) {
        this._settings = settings;
        this._onDone = onDone;

        this._phase = null;
        this._event = null;
        this._timeline = null;
        this._morph = null;
        this._phaseTimer = 0;
        this._dotCount = 8;

        this.actor = new St.Widget({
            name: CAPSULE_ACTOR_NAME,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            /* Added hidden and given geometry before it is shown: the layout
             * manager walks its chrome the moment the actor joins it, and an
             * actor with no allocation makes it complain once per frame. */
            visible: false,
            opacity: 0,
        });
        this.actor.set_pivot_point(0.5, 0);

        this._body = new St.BoxLayout({
            style_class: 'di-capsule',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this._body);

        const stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            width: GLYPH_SIZE,
            height: GLYPH_SIZE,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._glyphStack = stack;
        this._body.add_child(stack);

        this._glyph = new St.DrawingArea({width: GLYPH_SIZE, height: GLYPH_SIZE});
        this._glyph.connect('repaint', () => this._paintGlyph());
        stack.add_child(this._glyph);

        this._icon = new St.Icon({
            style_class: 'di-capsule-icon',
            icon_size: 22,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        /* set_pivot_point() takes two floats. Clutter.Point is not constructible
         * from GJS here -- the boxed type is Graphene's now -- and reaching for
         * the setter sidesteps the question entirely. */
        this._icon.set_pivot_point(0.5, 0.5);
        stack.add_child(this._icon);

        this._text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'di-capsule-text',
        });
        this._body.add_child(this._text);

        this._title = new St.Label({style_class: 'di-capsule-title'});
        this._title.clutter_text.ellipsize = 3; /* Pango END */
        this._text.add_child(this._title);

        this._bodyLabel = new St.Label({style_class: 'di-capsule-body'});
        this._bodyLabel.clutter_text.ellipsize = 3;
        this._bodyLabel.clutter_text.line_wrap = true;
        this._text.add_child(this._bodyLabel);

        /* Hovering holds whatever act it is in. Something you are still reading
         * should not be taken away because a timer says so. */
        this.actor.connect('notify::hover', () => {
            if (this.actor.hover)
                this._cancelPhaseTimer();
            else if (this._phase)
                this._armPhaseTimer();
        });

        this.actor.connect('button-press-event', () => this._activate());
    }

    get showing() {
        return !!this._phase;
    }

    /* ----------------------------------------------------------- showing */

    show(event, {ringDots = 8} = {}) {
        this._event = event;
        this._dotCount = ringDots;

        this._title.text = event.title ?? '';
        this._bodyLabel.text = event.body ?? '';
        this._bodyLabel.visible = !!event.body;

        if (event.gicon)
            this._icon.gicon = event.gicon;
        else
            this._icon.icon_name = event.iconName ?? 'dialog-information-symbolic';

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._applyStyle(Phase.FULL);
        this.actor.show();

        const width = Math.min(FULL_WIDTH, monitor.width - 80);
        const height = this._measureHeight(width);

        /* It arrives from behind the top edge rather than fading in on the
         * spot: the pill should look as though it came out of the bezel. */
        this._setGeometry(width, 0);
        this.actor.translation_y = -12;
        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 255,
            translation_y: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._phase = Phase.FULL;
        this._morphTo(width, height, () => this._runGlyph());
        this._armPhaseTimer();
    }

    /* The second act: the same pill, drawn in around the icon and one line. */
    _toCompact() {
        if (this._phase !== Phase.FULL)
            return;

        this._phase = Phase.COMPACT;
        this._stopGlyph();
        this._applyStyle(Phase.COMPACT);

        const width = this._measureCompactWidth();
        this._morphTo(width, COMPACT_HEIGHT);
        this._armPhaseTimer();
    }

    dismiss() {
        if (!this._phase)
            return;

        this._phase = null;
        this._cancelPhaseTimer();
        this._stopGlyph();
        this._stopMorph();

        this.actor.remove_all_transitions();
        this.actor.ease({
            opacity: 0,
            translation_y: -14,
            scale_x: 0.88,
            scale_y: 0.88,
            duration: AWAY_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onComplete: () => {
                this.actor.hide();
                this.actor.translation_y = 0;
                this.actor.set_scale(1, 1);
                this._event = null;
                this._onDone?.();
            },
        });
    }

    /* A banner you click is a banner you want to act on. Resident
     * notifications keep themselves alive; the shell decides that, not us. */
    _activate() {
        const notification = this._event?.notification;

        if (notification && !notification._destroyed) {
            try {
                notification.activate();
            } catch (e) {
                logError(e, 'dynamic-island: could not activate the notification');
            }
        }

        this.dismiss();
        return Clutter.EVENT_STOP;
    }

    /* ---------------------------------------------------------- geometry */

    _armPhaseTimer() {
        this._cancelPhaseTimer();

        const key = this._phase === Phase.FULL ? 'event-dwell' : 'event-compact-dwell';
        const delay = this._settings.get_int(key);

        this._phaseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._phaseTimer = 0;

            if (this._phase === Phase.FULL)
                this._toCompact();
            else
                this.dismiss();

            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPhaseTimer() {
        if (this._phaseTimer) {
            GLib.Source.remove(this._phaseTimer);
            this._phaseTimer = 0;
        }
    }

    /* The pill is centred, so its position follows from its width. Stepping
     * both from one timeline is what keeps the two in agreement; easing them as
     * separate transitions lets them disagree by a pixel every frame, and a
     * centred shape that jitters horizontally is very visible. */
    _morphTo(toWidth, toHeight, onDone) {
        this._stopMorph();

        const fromWidth = this.actor.width;
        const fromHeight = this.actor.height;

        const apply = progress => {
            this._setGeometry(
                Math.round(fromWidth + (toWidth - fromWidth) * progress),
                Math.round(fromHeight + (toHeight - fromHeight) * progress));
        };

        const timeline = new Clutter.Timeline({
            duration: MORPH_MS,
            actor: this.actor,
        });
        timeline.set_progress_mode(Clutter.AnimationMode.EASE_OUT_EXPO);

        let cancelled = false;
        timeline.connect('new-frame', () => apply(timeline.get_progress()));
        timeline.connect('stopped', () => {
            if (cancelled)
                return;
            this._morph = null;
            apply(1);
            onDone?.();
        });

        this._morph = {timeline, cancel: () => (cancelled = true)};
        timeline.start();
    }

    _stopMorph() {
        if (!this._morph)
            return;

        const {timeline, cancel} = this._morph;
        this._morph = null;
        cancel();
        timeline.stop();
        timeline.run_dispose();
    }

    _setGeometry(width, height) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this.actor.set_size(width, height);
        this.actor.set_position(
            monitor.x + Math.round((monitor.width - width) / 2),
            monitor.y + this._topOffset());
    }

    /* Clear of the island, whether or not the island is on screen: a capsule
     * that jumped up and down depending on a fullscreen window would be worse
     * than one that always sits a little lower. */
    _topOffset() {
        const s = this._settings;
        const gap = s.get_string('style') === 'floating' ? s.get_int('top-gap') : 0;
        return s.get_int('island-height') + gap + 8;
    }

    _measureHeight(forWidth) {
        const [, height] = this._body.get_preferred_height(forWidth - FULL_PADDING * 2);
        return Math.max(COMPACT_HEIGHT, Math.round(height) + FULL_PADDING * 2);
    }

    /* The compact pill is as wide as its one line, within reason.
     *
     * The title ellipsizes, and an ellipsizing label asks for almost nothing --
     * Pango is entitled to cut the text, so it reports a minimum rather than
     * the width of what it holds. Asked as it stands, every capsule came back
     * at the floor of 140 px with the title clipped. So the question is put
     * with the cut turned off, and the answer clamped. */
    _measureCompactWidth() {
        const text = this._title.clutter_text;
        const ellipsize = text.ellipsize;

        text.ellipsize = 0; /* Pango NONE */
        const [, width] = this._body.get_preferred_width(COMPACT_HEIGHT);
        text.ellipsize = ellipsize;

        return Math.min(COMPACT_MAX_WIDTH, Math.max(140, Math.round(width)));
    }

    /* ------------------------------------------------------------- style */

    _applyStyle(phase) {
        const s = this._settings;
        const opacity = s.get_double('bg-opacity').toFixed(3);
        const full = phase === Phase.FULL;

        /* Fully rounded when compact, softly rounded when full -- the same
         * relationship the island has between its pill and its panel. */
        const radius = full ? 24 : COMPACT_HEIGHT / 2;

        this.actor.set_style(
            `background-color: rgba(0, 0, 0, ${opacity}); border-radius: ${radius}px;`);

        this._body.style_class = full
            ? 'di-capsule di-capsule-full'
            : 'di-capsule di-capsule-compact';

        this._glyphStack.set_size(full ? GLYPH_SIZE : 24, full ? GLYPH_SIZE : 24);
        this._glyph.set_size(full ? GLYPH_SIZE : 24, full ? GLYPH_SIZE : 24);
        this._glyph.visible = full;
        this._icon.icon_size = full ? 22 : 15;

        this._bodyLabel.visible = full && !!this._event?.body;
        this._title.style_class = full
            ? 'di-capsule-title'
            : 'di-capsule-title di-capsule-title-compact';

        this._applyBlur();
    }

    _applyBlur() {
        this.actor.remove_effect_by_name(BLUR_EFFECT_NAME);
        if (!this._settings.get_boolean('island-blur'))
            return;

        try {
            this.actor.add_effect_with_name(BLUR_EFFECT_NAME, new Shell.BlurEffect({
                name: BLUR_EFFECT_NAME,
                mode: Shell.BlurMode.BACKGROUND,
                radius: this._settings.get_int('blur-radius'),
                brightness: this._settings.get_double('blur-brightness'),
            }));
        } catch (e) {
            logError(e, 'dynamic-island: blur effect unavailable');
        }
    }

    /* ------------------------------------------------------------- glyph */

    _runGlyph() {
        this._stopGlyph();

        this._icon.remove_all_transitions();
        this._icon.set_scale(0.55, 0.55);
        this._icon.ease({
            scale_x: 1,
            scale_y: 1,
            duration: 420,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        const timeline = new Clutter.Timeline({duration: GLYPH_MS, actor: this._glyph});
        timeline.connect('new-frame', () => this._glyph?.queue_repaint());
        timeline.connect('stopped', () => {
            this._timeline = null;
            this._glyph?.queue_repaint();
        });

        this._timeline = timeline;
        timeline.start();
    }

    _stopGlyph() {
        if (this._timeline) {
            const timeline = this._timeline;
            this._timeline = null;
            timeline.stop();
            timeline.run_dispose();
        }
    }

    _paintGlyph() {
        if (!this._glyph.visible)
            return;

        const cr = this._glyph.get_context();
        const progress = this._timeline?.get_progress() ?? 1;
        const size = this._glyph.width;
        const half = size / 2;
        const [r, g, b] = motifFor(this._event?.kind).rgb;

        switch (this._event?.kind) {
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
            cr.setSourceRGBA(r, g, b, (1 - phase) * 0.55);
            cr.arc(half, half, 11 + phase * 11, 0, 2 * Math.PI);
            cr.stroke();
        }
    }

    /* Three arcs lighting in sequence -- the shape every radio indicator uses,
     * which is why it needs no caption. */
    _paintArcs(cr, half, r, g, b, progress) {
        cr.setLineWidth(2.2);
        cr.setLineCap(1); /* ROUND */

        for (let i = 0; i < 3; i++) {
            const phase = Math.min(1, Math.max(0, progress * 3 - i));
            if (phase <= 0)
                continue;

            cr.setSourceRGBA(r, g, b, 0.25 + phase * 0.55);
            cr.arc(half - 6, half, 13 + i * 5, -Math.PI / 4, Math.PI / 4);
            cr.stroke();
        }
    }

    /* A ring filling to the charge level, clockwise from twelve. Draining runs
     * the other way, so plugging in and unplugging are opposite gestures and
     * not merely opposite colours. */
    _paintFill(cr, half, r, g, b, progress, charging) {
        const radius = half - 4;
        const target = this._event?.fraction ?? 1;
        const eased = charging ? progress : 1 - progress;
        const sweep = target * eased * 2 * Math.PI;

        cr.setLineWidth(3.5);
        cr.setLineCap(1);

        cr.setSourceRGBA(1, 1, 1, 0.12);
        cr.arc(half, half, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (sweep > 0.01) {
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(half, half, radius, -Math.PI / 2, -Math.PI / 2 + sweep);
            cr.stroke();
        }
    }

    /* The focus ring's dots, let go: they leave the circle outward and fade, in
     * two waves so the ring empties rather than vanishing. */
    _paintScatter(cr, half, r, g, b, progress) {
        const count = Math.max(4, this._dotCount);

        for (let wave = 0; wave < 2; wave++) {
            const phase = Math.min(1, Math.max(0, progress * 1.6 - wave * 0.25));
            if (phase <= 0)
                continue;

            const radius = 14 + phase * 9;
            const dotRadius = 3.2 * (1 - phase);
            if (dotRadius <= 0.2)
                continue;

            cr.setSourceRGBA(r, g, b, (1 - phase) * (wave === 0 ? 0.9 : 0.45));

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
        this._cancelPhaseTimer();
        this._stopGlyph();
        this._stopMorph();

        this.actor?.destroy();
        this.actor = null;
        this._glyph = null;
        this._icon = null;
        this._event = null;
    }
}
