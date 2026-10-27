/* Dynamic Island -- the search pane.
 *
 * This does not reimplement search. It instantiates the shell's own
 * SearchResultsView, the same object the overview uses, so everything the
 * desktop can already find -- applications, settings panels, files, the
 * calculator, characters, and any installed search provider -- is found here
 * too, ranked the same way.
 *
 * Two things had to be worked around to host it outside the overview.
 *
 * Typing. The island lives in the shell's chrome, and chrome does not receive
 * key events: they go to the focused window. So the pane takes a modal grab,
 * which is how the overview and the run dialog read a keyboard. A grab also
 * swallows clicks everywhere else, which would be a nasty surprise for someone
 * who only scrolled past this pane -- so it is taken when the field is clicked,
 * never merely because the pane is on screen, and dropped on Escape, on
 * activation, and when the island closes.
 *
 * Activating. A result's activate() ends with Main.overview.toggle(), which
 * inside the overview closes it and outside it would open it. The call is
 * synchronous, so it is shimmed away for exactly the length of the activation.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Search from 'resource:///org/gnome/shell/ui/search.js';

/* Held at a fixed height rather than following the results: providers answer
 * one after another over a few hundred milliseconds, and a pane that grew with
 * each answer would make the island jump four or five times per query. */
const RESULTS_HEIGHT = 250;

export class SearchPane {
    constructor({onHeightChange, onGrabChanged} = {}) {
        this._onHeightChange = onHeightChange;
        this._onGrabChanged = onGrabChanged;
        this._grab = null;
        this._searching = false;
        this._debounce = 0;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'di-search',
            x_expand: true,
        });

        this._entry = new St.Entry({
            style_class: 'di-search-entry',
            hint_text: 'Rechercher…',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({
            style_class: 'di-search-icon',
            icon_name: 'edit-find-symbolic',
            icon_size: 14,
        }));
        this.actor.add_child(this._entry);

        this._entry.clutter_text.connect('text-changed', () => this._queueSearch());
        this._entry.clutter_text.connect('key-press-event',
            (_actor, event) => this._onKeyPress(event));

        /* The grab is the point of this click, so it is taken on press rather
         * than on a 'clicked' that St.Entry does not emit. */
        this._entry.connect('button-press-event', () => {
            this.grabKeyboard();
            return Clutter.EVENT_PROPAGATE;
        });

        this._results = new Search.SearchResultsView();
        this._resultsBox = new St.Bin({
            style_class: 'di-search-results',
            x_expand: true,
            height: 0,
            visible: false,
            child: this._results,
        });
        this.actor.add_child(this._resultsBox);
    }

    /* ----------------------------------------------------------- keyboard */

    grabKeyboard() {
        if (this._grab)
            return;

        /* NORMAL rather than POPUP: the island is not a menu, and POPUP would
         * block the shell's own keybindings for as long as the field is open. */
        this._grab = Main.pushModal(this.actor, {
            actionMode: Shell.ActionMode.NORMAL,
        });

        if (!this._grab) {
            /* Something else already holds a grab -- a menu, the overview.
             * Typing would go nowhere, so say nothing rather than pretend. */
            return;
        }

        global.stage.set_key_focus(this._entry.clutter_text);
        this._onGrabChanged?.(true);
    }

    releaseKeyboard() {
        if (!this._grab)
            return;

        const grab = this._grab;
        this._grab = null;

        Main.popModal(grab);
        global.stage.set_key_focus(null);
        this._onGrabChanged?.(false);
    }

    get hasGrab() {
        return !!this._grab;
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();

        switch (symbol) {
        case Clutter.KEY_Escape:
            /* First Escape clears, a second one lets go: the common case is a
             * mistyped query, not a change of mind about searching at all. */
            if (this._entry.text)
                this._entry.set_text('');
            else
                this.releaseKeyboard();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activate();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
            this._results.navigateFocus(St.DirectionType.TAB_FORWARD);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            this._results.navigateFocus(St.DirectionType.TAB_BACKWARD);
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _activate() {
        if (!this._searching)
            return;

        /* Result activation ends with Main.overview.toggle(). In the overview
         * that closes it; from here it would open it, which is the opposite of
         * what opening a file should do. The call is synchronous, so replacing
         * it for the length of the activation is enough -- and restoring it in
         * a finally means a provider that throws cannot leave the shell with a
         * dead overview. */
        const overview = Main.overview;
        const original = overview.toggle;
        overview.toggle = () => {};

        try {
            this._results.activateDefault();
        } catch (e) {
            logError(e, 'dynamic-island: search activation failed');
        } finally {
            overview.toggle = original;
        }

        this._entry.set_text('');
        this.releaseKeyboard();
    }

    /* ------------------------------------------------------------- search */

    /* Keystrokes are coalesced before the providers are told. SearchResultsView
     * debounces internally as well, but every call still cancels and restarts
     * the remote providers' D-Bus requests. */
    _queueSearch() {
        this._cancelDebounce();
        this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._debounce = 0;
            this._runSearch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _runSearch() {
        const text = this._entry.get_text().trim();
        const terms = text.length > 0 ? text.split(/\s+/) : [];

        this._results.setTerms(terms);
        this._results.highlightDefault(terms.length > 0);

        const searching = terms.length > 0;
        if (searching === this._searching)
            return;

        this._searching = searching;
        this._resultsBox.visible = searching;
        this._resultsBox.height = searching ? RESULTS_HEIGHT : 0;

        /* The island is the one place that owns its own geometry, so the pane
         * reports the change rather than animating itself. */
        this._onHeightChange?.();
    }

    _cancelDebounce() {
        if (this._debounce) {
            GLib.Source.remove(this._debounce);
            this._debounce = 0;
        }
    }

    /* -------------------------------------------------------- pane hooks */

    start() {
        /* No grab here on purpose: showing the pane must not capture the
         * keyboard of whatever the person was actually doing. */
    }

    stop() {
        this._cancelDebounce();
        this.releaseKeyboard();
        this._entry.set_text('');
        this._results.setTerms([]);
        this._searching = false;
        this._resultsBox.visible = false;
        this._resultsBox.height = 0;
    }

    destroy() {
        this._cancelDebounce();
        this.releaseKeyboard();
        this.actor?.destroy();
        this.actor = null;
        this._results = null;
        this._entry = null;
        this._resultsBox = null;
    }
}
