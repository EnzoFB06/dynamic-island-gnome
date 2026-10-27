UUID = dynamic-island@EnzoFB06.github.com
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all install uninstall enable disable schemas pack clean

all: schemas

# GSettings schemas must be compiled before the extension can read them.
schemas:
	glib-compile-schemas $(UUID)/schemas

# --remove-destination is not a detail: GSettings keeps gschemas.compiled
# mmap'd for as long as a schema source is alive, and plain cp opens the
# destination with O_TRUNC. Truncating a file GNOME Shell has mapped makes the
# schema read as having no keys at all, and GLib treats a missing key as a
# programming error -- g_error(), which aborts the process. On Wayland the
# compositor *is* the session, so installing over a running shell logged the
# user out. Unlinking first leaves the old inode intact for the mapping that
# still refers to it, and the new file is a new inode nobody has mapped yet.
install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r --remove-destination $(UUID)/. $(INSTALL_DIR)/
	@echo
	@echo "Installed to $(INSTALL_DIR)"
	@echo "GNOME Shell only discovers a new extension at startup:"
	@echo "  Wayland  -> log out and back in"
	@echo "  X11      -> Alt+F2, type 'r', Enter"
	@echo "Then:  gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions disable $(UUID) 2>/dev/null || true
	rm -rf $(INSTALL_DIR)
	@echo "Removed $(INSTALL_DIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Builds the zip that extensions.gnome.org expects.
pack: schemas
	cd $(UUID) && zip -r ../$(UUID).shell-extension.zip . -x '*.zip'
	@echo "Wrote $(UUID).shell-extension.zip"

clean:
	rm -f $(UUID)/schemas/gschemas.compiled
	rm -f *.shell-extension.zip
