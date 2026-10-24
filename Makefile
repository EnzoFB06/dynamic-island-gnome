UUID = dynamic-island@EnzoFB06.github.com
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all install uninstall enable disable schemas pack clean

all: schemas

# GSettings schemas must be compiled before the extension can read them.
schemas:
	glib-compile-schemas $(UUID)/schemas

install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r $(UUID)/. $(INSTALL_DIR)/
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
