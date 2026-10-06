APP := build/OpenWhisper.app
CLT_DEV := /Library/Developer/CommandLineTools/Library/Developer
# Command Line Tools-only installations need explicit swift-testing linker paths.
ifeq ($(shell xcode-select -p 2>/dev/null),/Library/Developer/CommandLineTools)
TEST_FLAGS := -Xswiftc -F -Xswiftc $(CLT_DEV)/Frameworks \
	-Xlinker -F -Xlinker $(CLT_DEV)/Frameworks \
	-Xlinker -rpath -Xlinker $(CLT_DEV)/Frameworks \
	-Xlinker -rpath -Xlinker $(CLT_DEV)/usr/lib
endif

# UNIVERSAL=1 builds for Apple Silicon and Intel; UPDATE_REPO=owner/repo enables updates.
BUILD_ENV := UNIVERSAL="$(UNIVERSAL)" UPDATE_REPO="$(UPDATE_REPO)"

.PHONY: app run install test zip dmg release clean

app:
	$(BUILD_ENV) scripts/build-app.sh

run: app
	open $(APP)

install: app
	rm -rf /Applications/OpenWhisper.app
	cp -R $(APP) /Applications/
	open /Applications/OpenWhisper.app

test:
	scripts/fetch-whisper.sh
	# Integration tests launch system processes and check code signatures synchronously.
	swift test --no-parallel $(TEST_FLAGS)

zip: app
	cd build && rm -f OpenWhisper-macOS.zip && ditto -c -k --keepParent OpenWhisper.app OpenWhisper-macOS.zip
	@echo "✓ build/OpenWhisper-macOS.zip"

dmg: app
	bash scripts/build-dmg.sh

# Local: make release UPDATE_REPO=user/OpenWhisper; normally handled by .github/workflows/release.yml
release: zip dmg

clean:
	rm -rf .build build
