TS_SOURCES        := $(shell find src test -name '*.ts' 2>/dev/null)

.PHONY: build lint test precommit install update pack publish wasm clean

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

precommit: lint test

install:
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
