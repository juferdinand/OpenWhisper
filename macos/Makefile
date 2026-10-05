APP := build/WhisperFree.app
CLT_DEV := /Library/Developer/CommandLineTools/Library/Developer
# Nur mit den Command Line Tools (ohne Xcode) muss swift-testing explizit verlinkt werden.
ifeq ($(shell xcode-select -p 2>/dev/null),/Library/Developer/CommandLineTools)
TEST_FLAGS := -Xswiftc -F -Xswiftc $(CLT_DEV)/Frameworks \
	-Xlinker -F -Xlinker $(CLT_DEV)/Frameworks \
	-Xlinker -rpath -Xlinker $(CLT_DEV)/Frameworks \
	-Xlinker -rpath -Xlinker $(CLT_DEV)/usr/lib
endif

# UNIVERSAL=1 baut für Apple Silicon + Intel (braucht Xcode), UPDATE_REPO=owner/repo aktiviert den Updater.
BUILD_ENV := UNIVERSAL="$(UNIVERSAL)" UPDATE_REPO="$(UPDATE_REPO)"

.PHONY: app run install test zip release clean

app:
	$(BUILD_ENV) scripts/build-app.sh

run: app
	open $(APP)

install: app
	rm -rf /Applications/WhisperFree.app
	cp -R $(APP) /Applications/
	open /Applications/WhisperFree.app

test:
	scripts/fetch-whisper.sh
	swift test $(TEST_FLAGS)

zip: app
	cd build && rm -f WhisperFree-macOS.zip && ditto -c -k --keepParent WhisperFree.app WhisperFree-macOS.zip
	@echo "✓ build/WhisperFree-macOS.zip"

# Lokal: make release UPDATE_REPO=user/WhisperFree – normalerweise erledigt das .github/workflows/release.yml
release: zip

clean:
	rm -rf .build build
