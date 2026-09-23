# 002: Money and rates are integers

Status: accepted

## Context
Statements must foot to the cent before rounding to dollars, and the same inputs must give byte-identical
output. Binary floating point can't represent most decimal fractions exactly, and its rounding depends on
the order of operations.

## Decision
- Rust: money is `Money(i64)` in cents. Rates are `rate_bp: u32` in basis points, so 12.5% is `1250`.
- Intermediate calculations that multiply money by rates (depreciation, GST) use `i128` and round once to
  cents, half away from zero.
- Statements round each line to whole dollars, half away from zero, in one core implementation.
- TypeScript: money is integer cents in a `number`. It's parsed and formatted only through
  `apps/web/src/lib/money.ts`.
- ts-rs maps `i64` to `number`, not `bigint` (`TS_RS_LARGE_INT = "number"` in `.cargo/config.toml`),
  because JSON delivers plain numbers. The largest safe integer, about 9 × 10^15 cents (roughly
  $90 trillion), is far beyond any amount this practice handles.
- No `f32` or `f64` anywhere in money or rate paths, on either side.

## Consequences
- Rates that aren't whole basis points, such as 1/3, can't be stored exactly. See the open question in
  PLAN.md about straight-line rates versus useful lives.
- The UI never does authoritative arithmetic. It shows live figures (such as an out-of-balance amount)
  in integer cents, and the server recomputes them.
