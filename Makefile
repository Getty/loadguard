# Local build of the C hook into build/bin/. Installed, the plugin builds
# itself on SessionStart into ${CLAUDE_PLUGIN_DATA}/bin (hooks/loadguard-build);
# flags and staleness live in lib/loadguard/build.py, not here.

all:
	python3 hooks/loadguard-build --foreground build

test:
	python3 -m unittest discover -s t -v

clean:
	rm -rf build

.PHONY: all test clean
