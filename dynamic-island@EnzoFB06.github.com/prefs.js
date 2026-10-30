import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DynamicIslandPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({title: 'Encoche'});
        window.add(page);

        /* ------------------------------------------------------------ forme */
        const shape = new Adw.PreferencesGroup({
            title: 'Forme',
            description: 'La barre du haut reste masquée dans tous les cas : les fenêtres occupent toute la hauteur de l’écran.',
        });
        page.add(shape);

        const style = new Adw.ComboRow({
            title: 'Style',
            subtitle: 'Encoche : collée au bord, coins du bas arrondis. Flottante : pastille détachée du bord.',
            model: new Gtk.StringList({strings: ['Encoche (macOS)', 'Pastille flottante']}),
        });
        style.selected = settings.get_string('style') === 'floating' ? 1 : 0;
        style.connect('notify::selected', row => {
            settings.set_string('style', row.selected === 1 ? 'floating' : 'notch');
        });
        shape.add(style);

        shape.add(this._spin(settings, 'corner-radius', 'Arrondi des coins', 'En pixels.', 0, 40));
        shape.add(this._spin(settings, 'island-height', 'Hauteur', 'En pixels.', 20, 60));
        shape.add(this._spin(settings, 'side-padding', 'Marge intérieure', 'Espace à gauche et à droite du contenu.', 0, 40));

        const gap = this._spin(settings, 'top-gap', 'Écart avec le haut de l’écran',
            'Uniquement en style pastille flottante.', 0, 40);
        shape.add(gap);
        const syncGap = () => {
            gap.sensitive = settings.get_string('style') === 'floating';
        };
        settings.connect('changed::style', syncGap);
        syncGap();

        /* ------------------------------------------------------------ aspect */
        const look = new Adw.PreferencesGroup({title: 'Apparence'});
        page.add(look);

        const opacity = new Adw.SpinRow({
            title: 'Opacité du fond',
            subtitle: '1,0 = noir opaque, 0,0 = totalement transparent.',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1, step_increment: 0.05, page_increment: 0.1,
            }),
            digits: 2,
        });
        settings.bind('bg-opacity', opacity, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(opacity);

        const blur = new Adw.SwitchRow({
            title: 'Verre depoli',
            subtitle: 'Floute ce qui passe derriere l\u2019encoche. Baisse l\u2019opacite du fond '
                + 'pour que le flou se voie. Remplace le flou que Blur My Shell appliquait '
                + 'a toute la barre, suspendu automatiquement tant que cette extension est active.',
        });
        settings.bind('island-blur', blur, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(blur);

        const blurRadius = this._spin(settings, 'blur-radius', 'Intensite du flou',
            'Rayon en pixels.', 0, 200);
        look.add(blurRadius);

        const blurBrightness = new Adw.SpinRow({
            title: 'Luminosite du flou',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 1, step_increment: 0.05, page_increment: 0.1,
            }),
            digits: 2,
        });
        settings.bind('blur-brightness', blurBrightness, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(blurBrightness);

        const syncBlur = () => {
            const on = settings.get_boolean('island-blur');
            blurRadius.sensitive = on;
            blurBrightness.sensitive = on;
        };
        settings.connect('changed::island-blur', syncBlur);
        syncBlur();

        const allMonitors = new Adw.SwitchRow({
            title: 'Une encoche sur chaque ecran',
            subtitle: 'Le shell n\u2019a qu\u2019un seul panneau, donc seul l\u2019ecran principal '
                + 'peut porter la vraie horloge et le centre de controle. Les autres ecrans '
                + 'recoivent une encoche identique affichant l\u2019heure, avec le meme survol.',
        });
        settings.bind('all-monitors', allMonitors, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(allMonitors);

        /* ------------------------------------------------------------ timer */
        const timer = new Adw.PreferencesGroup({
            title: 'Timer de focus',
            description: 'La duree se regle aussi depuis l\u2019encoche : les boutons − et + '
                + 'bougent par pas, la molette sur l\u2019anneau d\u2019une minute.',
        });
        page.add(timer);

        /* Stored in seconds so the island can hold 1:30; shown in minutes,
         * which is the unit anyone setting a session thinks in. The island
         * itself has presets, a scroll on the ring and a field you type into,
         * so this row is the long way round -- it exists for completeness. */
        const duration = new Adw.SpinRow({
            title: 'Duree d\u2019une session',
            subtitle: 'En minutes. Dans l\u2019encoche : les prereglages, la molette sur '
                + 'l\u2019anneau, ou un clic sur le temps pour le saisir.',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 1440, step_increment: 1, page_increment: 5,
            }),
        });
        duration.value = Math.round(settings.get_int('focus-seconds') / 60);
        duration.connect('notify::value',
            () => settings.set_int('focus-seconds', Math.round(duration.value) * 60));
        settings.connect('changed::focus-seconds', () => {
            const minutes = Math.round(settings.get_int('focus-seconds') / 60);
            if (Math.round(duration.value) !== minutes)
                duration.value = minutes;
        });
        timer.add(duration);

        timer.add(this._spin(settings, 'ring-dots',
            'Ronds de la fin de session',
            'Le nombre de ronds que l\u2019anneau projette vers l\u2019exterieur quand une '
            + 'session se termine.', 4, 60));

        const corners = new Adw.SwitchRow({
            title: 'Coins concaves',
            subtitle: 'Evase les coins hauts de l\u2019encoche vers le bord de l\u2019ecran, '
                + 'comme l\u2019encoche des MacBook. Sans effet en style pastille flottante.',
        });
        settings.bind('concave-corners', corners, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(corners);

        /* ----------------------------------------------------------- events */
        const events = new Adw.PreferencesGroup({
            title: 'Ev\u00e9nements',
            description: 'Un \u00e9v\u00e9nement prend bri\u00e8vement l\u2019encoche : elle s\u2019\u00e9largit en '
                + 'capsule, joue une animation propre \u00e0 ce qui vient d\u2019arriver, puis '
                + 'redevient une pastille. Survoler la capsule l\u2019ouvre en panneau complet.',
        });
        page.add(events);

        const capsules = new Adw.SwitchRow({
            title: 'Activer les capsules',
        });
        settings.bind('event-capsules', capsules, 'active', Gio.SettingsBindFlags.DEFAULT);
        events.add(capsules);

        const kinds = [
            ['events-notifications', 'Notifications',
                'Les m\u00eames que la barre afficherait : le mode Ne pas d\u00e9ranger et les '
                + 'applications mises en sourdine sont respect\u00e9s.'],
            ['events-power', 'Branchement du chargeur',
                'Un anneau se remplit jusqu\u2019au niveau de la batterie, et se vide dans '
                + 'l\u2019autre sens au d\u00e9branchement.'],
            ['events-bluetooth', 'Connexion Bluetooth',
                'Trois arcs qui s\u2019allument, comme un indicateur radio.'],
            ['events-timer', 'Fin du timer de focus',
                'Les ronds de l\u2019anneau quittent le cercle vers l\u2019ext\u00e9rieur.'],
        ];

        const rows = [];
        for (const [key, title, subtitle] of kinds) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            events.add(row);
            rows.push(row);
        }

        const dwell = this._spin(settings, 'event-dwell',
            'Dur\u00e9e de la grande capsule',
            'Avant qu\u2019elle ne se resserre, en millisecondes.', 800, 10000);
        events.add(dwell);

        const compact = this._spin(settings, 'event-compact-dwell',
            'Dur\u00e9e de la petite capsule',
            'Le rappel d\u2019une ligne qui subsiste ensuite. 0 pour la supprimer.',
            0, 30000);
        events.add(compact);

        const replace = new Adw.SwitchRow({
            title: 'Remplacer les banni\u00e8res de GNOME',
            subtitle: 'Sans \u00e7a, la banni\u00e8re du shell se dessine par-dessus la capsule, '
                + 'au m\u00eame endroit et avec le m\u00eame texte.',
        });
        settings.bind('replace-banners', replace, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        events.add(replace);

        const sounds = new Adw.SwitchRow({
            title: 'Son',
            subtitle: 'Bloquer les banni\u00e8res les rend muettes : c’est la capsule qui '
                + 'porte le son. Suit le r\u00e9glage sonore du bureau.',
        });
        settings.bind('event-sounds', sounds, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        events.add(sounds);

        const inFullscreen = new Adw.SwitchRow({
            title: 'Aussi en plein \u00e9cran',
            subtitle: 'La capsule est d\u00e9tach\u00e9e de l\u2019encoche et ne se cache '
                + 'plus avec elle ; il ne reste que le cas du plein \u00e9cran.',
        });
        settings.bind('events-in-fullscreen', inFullscreen, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        events.add(inFullscreen);

        /* The per-kind switches say nothing while the whole feature is off. */
        const syncEvents = () => {
            const on = settings.get_boolean('event-capsules');
            for (const row of [...rows, dwell, compact, replace, sounds, inFullscreen])
                row.sensitive = on;
        };
        settings.connect('changed::event-capsules', syncEvents);
        syncEvents();

        /* -------------------------------------------------------- auto-hide */
        const auto = new Adw.PreferencesGroup({
            title: 'Masquage automatique',
            description: 'Reproduit la barre de menus macOS : en plein ecran elle s\u2019efface, '
                + 'et revient quand le pointeur touche le haut de l\u2019ecran.',
        });
        page.add(auto);

        const mode = new Adw.ComboRow({
            title: 'Quand s\u2019effacer',
            subtitle: 'Mutter ne considere pas une fenetre simplement maximisee comme plein '
                + 'ecran, quelle que soit sa taille -- d\u2019ou la troisieme option, qui '
                + 'interroge l\u2019etat de la fenetre directement.',
            model: new Gtk.StringList({strings: [
                'Jamais : toujours visible',
                'En plein ecran (comme macOS)',
                'En plein ecran et fenetre maximisee',
            ]}),
        });
        const MODES = ['never', 'fullscreen', 'fullscreen-and-maximized'];
        mode.selected = Math.max(0, MODES.indexOf(settings.get_string('autohide-mode')));
        mode.connect('notify::selected', row => {
            settings.set_string('autohide-mode', MODES[row.selected] ?? 'fullscreen');
        });
        auto.add(mode);

        auto.add(this._spin(settings, 'reveal-margin',
            'Largeur en plus de part et d\u2019autre',
            'La bande de survol fait la largeur de l\u2019encoche plus cette marge, '
            + 'au lieu de toute la largeur de l\u2019ecran -- pour que les boutons '
            + 'reduire / agrandir / fermer restent accessibles dans les coins.', 0, 200));

        auto.add(this._spin(settings, 'reveal-edge',
            'Zone de declenchement en haut',
            'Hauteur en pixels de la bande qui ramene l\u2019encoche. Elle n\u2019est '
            + 'sensible que lorsque l\u2019encoche est cachee.', 1, 20));

        auto.add(this._spin(settings, 'hide-delay',
            'Delai avant de se recacher',
            'En millisecondes, apres que le pointeur a quitte l\u2019encoche.', 0, 3000));

        auto.add(this._spin(settings, 'animation-duration',
            'Duree de l\u2019animation',
            'En millisecondes.', 0, 1000));

        /* --------------------------------------------------------- behaviour */
        const behaviour = new Adw.PreferencesGroup({title: 'Comportement'});
        page.add(behaviour);

        const reclaim = new Adw.SwitchRow({
            title: 'Rendre les pixels de la barre aux fenetres',
            subtitle: 'Active : les fenetres occupent toute la hauteur de l\u2019ecran et '
                + 'l\u2019encoche flotte par-dessus. Desactive : la barre reserve sa hauteur '
                + 'comme d\u2019habitude, donc rien n\u2019est jamais recouvert.',
        });
        settings.bind('reclaim-space', reclaim, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(reclaim);

        const keepFs = new Adw.SwitchRow({
            title: 'Garder l\u2019encoche par-dessus le plein ecran',
            subtitle: 'GNOME masque la barre des qu\u2019une fenetre couvre tout l\u2019ecran. '
                + 'Active, l\u2019encoche reste visible, meme sur une video en plein ecran.',
        });
        settings.bind('keep-in-fullscreen', keepFs, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(keepFs);

        const dockFix = new Adw.SwitchRow({
            title: 'Reparer le dock en plein ecran',
            subtitle: 'dash2dock-lite refuse de sortir au survol, et arrete sa boucle de rendu, '
                + 'des que le moniteur compte comme plein ecran -- ce qu\u2019une fenetre maximisee '
                + 'fait desormais. Neutralise ces blocages sans modifier cette extension.',
        });
        settings.bind('fix-dock-fullscreen', dockFix, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(dockFix);

        const activities = new Adw.SwitchRow({
            title: 'Masquer le bouton Activites',
            subtitle: 'La vue Activites reste accessible avec la touche Super.',
        });
        settings.bind('hide-activities', activities, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(activities);
    }

    _spin(settings, key, title, subtitle, lower, upper) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower, upper, step_increment: 1, page_increment: 4,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
