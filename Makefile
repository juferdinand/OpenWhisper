# Entry point for all platforms. See each platform directory for details.
.PHONY: mac mac-install linux linux-test linux-run linux-install test clean
LINUX_FEATURES ?= custom-protocol,vulkan

linux:
	bash linux/scripts/fetch-native.sh
	python3 linux/scripts/fetch-vulkan-headers.py
	cd shared/ui && npm ci && npm run build
	cargo build --locked --release --manifest-path linux/Cargo.toml -p openwhisper-desktop --features $(LINUX_FEATURES)

linux-test:
	python3 linux/scripts/test-local-installer.py
	bash linux/scripts/fetch-native.sh
	cd shared/ui && npm ci && npm run build
	cargo test --locked --manifest-path linux/Cargo.toml --workspace
	cargo clippy --locked --manifest-path linux/Cargo.toml --workspace --all-targets -- -D warnings
	python3 linux/scripts/check-assets.py

linux-run:
	linux/target/release/openwhisper-desktop

linux-install:
	bash linux/scripts/install-local.sh

mac:
	$(MAKE) -C macos app

mac-install:
	$(MAKE) -C macos install

test:
	$(MAKE) -C macos test

clean:
	$(MAKE) -C macos clean
