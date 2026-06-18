TS_SOURCES        := $(shell find src test -name '*.ts' 2>/dev/null)

.PHONY: build lint test test-integration precommit install update pack publish wasm clean adb-reverse adb-unreverse

PORT ?= 4962

.DEFAULT_GOAL := build

build: node_modules
	@npm run build

node_modules: package.json package-lock.json
	@npm install
	@touch node_modules

lint: node_modules
	@echo "==> lint"
	@npx tsc --noEmit

test: build
	@echo "==> test"
	@npm test

# black-box python integration test: builds, then spawns the standalone bin and
# drives the voice pipeline against fake-openai. auto-skips when the mock binary
# or node are unavailable.
test-integration: build
	@echo "==> test-integration"
	@python3 test/fake_openai_test.py

precommit: lint test test-integration

install: build
	@npm install -g .

pack: build
	@mkdir -p build
	@npm pack --pack-destination build

publish: build
	@npm publish --access public

update:
	@npm update
	@touch node_modules

wasm:
	@echo "==> wasm-pack build (apm)"
	@cd wasm/apm && wasm-pack build --target nodejs --release

clean:
	@rm -rf dist build

# forward usb-tethered android phone's localhost:PORT to laptop's
# localhost:PORT, so the phone browser can hit the dev server as
# http://localhost:PORT and pass web audio's secure-context check.
# requires usb debugging enabled on the phone and adb on the laptop.
adb-reverse:
	@adb reverse tcp:$(PORT) tcp:$(PORT)
	@echo "==> phone http://localhost:$(PORT) → laptop localhost:$(PORT)"

adb-unreverse:
	@adb reverse --remove tcp:$(PORT)
	@echo "==> removed phone reverse-forward for port $(PORT)"
