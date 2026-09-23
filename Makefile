.PHONY: setup dev test check types types-check db-reset

TYPES_DIR := packages/types/src

setup:
	cargo fetch
	pnpm install
	@cargo insta --version >/dev/null 2>&1 || cargo install cargo-insta --locked

dev:
	./scripts/dev.sh

test:
	cargo test --workspace
	pnpm -r test

check:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	$(MAKE) test
	pnpm -r typecheck
	$(MAKE) types-check

# ts-rs writes a type's .ts file when that type's generated export test runs.
# Clear the folder first so a type removed from Rust doesn't leave a stale file behind.
types:
	rm -f $(TYPES_DIR)/*.ts
	cargo test --workspace --quiet export_bindings

types-check: types
	@git diff --quiet -- $(TYPES_DIR) && test -z "$$(git ls-files --others --exclude-standard -- $(TYPES_DIR))" \
		|| { git status --short -- $(TYPES_DIR); echo "Generated types are out of date: run 'make types' and commit the result."; exit 1; }

# Wipes the dev database and loads the synthetic fixtures through the command pipeline.
db-reset:
	rm -f data/*.db data/*.db-*
	cargo run -q -p acct-server --bin acct-load-fixtures
