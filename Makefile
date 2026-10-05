# Einstiegspunkt für alle Plattformen. Details je Plattform im jeweiligen Unterordner.
.PHONY: mac mac-install test clean

mac:
	$(MAKE) -C macos app

mac-install:
	$(MAKE) -C macos install

test:
	$(MAKE) -C macos test

clean:
	$(MAKE) -C macos clean
