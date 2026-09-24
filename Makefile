.PHONY: setup dev test check types types-check db-reset web desktop desktop-check

TYPES_DIR := packages/types/src
DESKTOP := -p acct-desktop -p acct-master -p acct-client -p acct-dev

setup:
	cargo fetch
	pnpm install
	@cargo insta --version >/dev/null 2>&1 || cargo install cargo-insta --locked

dev:
	./scripts/dev.sh

test:
	cargo test
	pnpm -r test

check:
	cargo fmt --all --check
	cargo clippy --all-targets -- -D warnings
	$(MAKE) test
	pnpm -r typecheck
	$(MAKE) types-check

# ts-rs writes a type's .ts file when that type's generated export test runs.
# Clear the folder first so a type removed from Rust doesn't leave a stale file behind.
types:
	rm -f $(TYPES_DIR)/*.ts
	cargo test --quiet export_bindings

types-check: types
	@git diff --quiet -- $(TYPES_DIR) && test -z "$$(git ls-files --others --exclude-standard -- $(TYPES_DIR))" \
		|| { git status --short -- $(TYPES_DIR); echo "Generated types are out of date: run 'make types' and commit the result."; exit 1; }

# Wipes the dev database and loads the synthetic fixtures through the command pipeline.
db-reset:
	rm -f data/*.db data/*.db-*
	cargo run -q -p acct-server --bin acct-load-fixtures

web:
	pnpm --filter web build

# The desktop apps (ADR 006): acct-master, acct-client and acct-dev. They build the web app in, and
# on Linux need the webview libraries that scripts/desktop-deps.sh installs. The release workflow
# builds the Windows .exe files.
desktop: web
	cargo build --release $(DESKTOP)

desktop-check: web
	cargo clippy $(DESKTOP) --all-targets -- -D warnings
	cargo test $(DESKTOP)
	cargo test -p acct-server --features embed-web --lib web
