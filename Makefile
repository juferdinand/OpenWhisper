# Electron is the supported host application. Native platform adapters remain
# behind its locked TypeScript package and platform-specific build scripts.
.PHONY: setup test build linux mac clean

setup:
	npm ci --prefix app/ui
	npm ci --prefix app

test: setup
	npm run typecheck --prefix app
	npm test --prefix app

build: setup
	npm run setup --prefix app
	npm run build --prefix app

linux: setup
	npm run setup --prefix app
	npm run build --prefix app -- --stable --recording

mac: setup
	npm run setup --prefix app
	npm run build --prefix app -- --stable --recording

clean:
	rm -rf app/dist app/native/build-cpu app/native/capture/build app/native/linux-bus/build app/native/macos-capture/build app/native/macos-retirement/build app/native/macos-retirement/build-production
