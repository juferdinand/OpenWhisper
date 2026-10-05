# Entry point for all platforms. See each platform directory for details.
.PHONY: mac mac-install test clean

mac:
	$(MAKE) -C macos app

mac-install:
	$(MAKE) -C macos install

test:
	$(MAKE) -C macos test

clean:
	$(MAKE) -C macos clean
