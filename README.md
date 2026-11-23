[![Tidebreak](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![Rank](https://make.fun/badge/btc-race-24h-20261123-0511/nemesisbug/tidebreak-btc/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard)
[![Reward](https://make.fun/badge/btc-race-24h-20261123-0511/nemesisbug/tidebreak-btc/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# Tidebreak

A regime-aware cbBTC trading bot for the make.fun 24-hour BTC race
(`btc-race-24h-20261123-0511`): race a bot live for 24 hours on 1-minute
Coinbase Wrapped BTC bars, $1,000 of paper money, long only.

## The idea

One-minute bars are almost all noise. On the kit's frozen dev window the
per-bar return has a standard deviation of ~8 bps against a mean drift of
~0.25 bps, while a full-size round trip costs ~26 bps in fees, slippage and
pool impact. Any bot that trades often pays that round trip over and over
and loses to the noise — the kit's own EMA-crossover baseline loses $114.83
on the dev window, and every RSI/Bollinger dip-buy variant tested lost
$35–$80. Tidebreak therefore trades rarely and lets the position ride:

1. **Anchor** — buy the whole stake (all cash) on the first tradeable batch
   of the window and hold it.
2. **Guard** — while holding, remember the highest close since entry. If a
   close falls 2% or more below that peak, sell everything. The guard caps
   the damage of a down day; on the dev window it never fires.
3. **Re-entry** — after an exit, stay out for at least 240 bars (4 hours)
   and only come back when the close is back above its 240-bar average by
   1% *and* the 120-bar return is above +1.5%. A weak bounce does not get
   the bot back in.

A refused sell is retried on the next batch with the peak frozen, and a
refused buy is retried the same way, so a single slippage rejection never
strands the bot.

## Parameters

| Parameter | Value | Meaning |
| --- | --- | --- |
| `TRAIL_BPS` | 200 | Sell everything 2% below the peak close since entry |
| `COOLDOWN_BARS` | 240 | Bars to stay out after an exit |
| `SMA_BARS` | 240 | Lookback of the slow average that defines the regime |
| `REENTRY_ABOVE_SMA_BPS` | 100 | Re-entry needs the close 1% above that average |
| `REENTRY_MOM_BARS` / `REENTRY_MOM_BPS` | 120 / 150 | Re-entry needs the 120-bar return above +1.5% |
| `MAX_SLIPPAGE_BPS` | 100 | Every order caps slippage at 1% past its decision close |

## Local dev grade

Graded with the kit's own harness (`node cli/makefun.mjs grade-local --kit .
--bot <repo> --driver process`), two executions, byte-for-byte reproduced:

- **Net PnL +$32.17** on 1 trade, max drawdown 2.06% — the same as
  buy-and-hold, because the guard never fires on the dev window.
- On the same window run backwards (a falling market of −3.6%) the guard
  exits once and the bot loses $24.36 instead of buy-and-hold's $38.83.

## Layout

- `main.ts` — the bot. Speaks `agent-fun/bars-replay/v1` (newline-delimited
  JSON on stdin/stdout, one reply per batch echoing its seq) through the
  kit's SDK shim. Deterministic: pure float64 arithmetic over the closes it
  has seen, no clock, no environment, no randomness.
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's SDK shim
  (`sdk/makefun-bars.ts`).

## Run it

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Node 22 required (`node /bot/main.ts` is the grader's fixed command).
