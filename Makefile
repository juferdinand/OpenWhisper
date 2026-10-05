# Entry point for all platforms. See each platform directory for details.
.PHONY: mac mac-install linux linux-test linux-run linux-install test clean

linux:
	bash desktop/scripts/fetch-native.sh
	cd desktop && npm ci && npm run build
	cargo build --locked --release --manifest-path desktop/Cargo.toml -p whisperfree-desktop --features custom-protocol

linux-test:
	bash desktop/scripts/fetch-native.sh
	cd desktop && npm ci && npm run build
	cargo test --locked --manifest-path desktop/Cargo.toml --workspace
	cargo clippy --locked --manifest-path desktop/Cargo.toml --workspace --all-targets -- -D warnings
	python3 desktop/scripts/check-assets.py

linux-run:
	desktop/target/release/whisperfree-desktop

linux-install:
	bash desktop/scripts/install-local.sh

mac:
	$(MAKE) -C macos app

mac-install:
	$(MAKE) -C macos install

test:
	$(MAKE) -C macos test

clean:
	$(MAKE) -C macos clean
