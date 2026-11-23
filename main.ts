// Tidebreak — a regime-aware cbBTC trading bot for the make.fun 24h BTC race.
//
// The idea is deliberately boring, because the 1-minute bars of this race are
// almost all noise: the per-bar return on the dev window has a standard
// deviation of ~8 bps against a mean drift of ~0.25 bps, so any bot that
// trades often pays the ~26 bps round trip over and over and loses to the
// noise. Tidebreak therefore trades rarely and lets the position ride:
//
//   - Anchor: buy the whole stake (all cash) on the first tradeable batch of
//     the window and hold it. One asset, long only, no leverage.
//   - Guard: while holding, remember the highest close since entry. If a
//     close falls 2% or more below that peak, sell everything. The guard
//     caps the damage of a down day; on the dev window it never fires, so
//     the bot simply rides the window up.
//   - Re-entry: after an exit, stay out until the market proves itself
//     again — at least 240 bars (4 hours) of cooling off, the close back
//     above its 240-bar average by 1%, and the 120-bar return above +1.5%.
//     A weak bounce does not get the bot back in.
//
// Backtest (local replay model, validated byte-for-byte against the kit's
// grade-local on the buy-and-hold and ema-cross baselines): dev window
// net PnL +$32.17 on 1 trade, max drawdown 2.06% — the same as buy-and-hold,
// because the guard never fires there. On the same window run backwards
// (a falling market of -3.6%) the guard exits once and the bot loses $24.36
// instead of buy-and-hold's $38.83.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's SDK shim: one
// JSON line per batch on stdin, one reply per batch on stdout echoing its
// seq, with the orders decided on that batch. It is deterministic — pure
// float64 arithmetic over the closes it has seen, no clock, no environment,
// no randomness — so two runs on the same bars produce the same orders.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Sell everything once the close is this far below the peak since entry. */
const TRAIL_BPS = 200;
/** Bars to stay out after an exit before a re-entry is even considered. */
const COOLDOWN_BARS = 240;
/** Re-entry needs the close this far above its 240-bar average. */
const REENTRY_ABOVE_SMA_BPS = 100;
/** Re-entry needs the 120-bar return above this. */
const REENTRY_MOM_BARS = 120;
const REENTRY_MOM_BPS = 150;
/** Lookback of the slow average that defines the regime. */
const SMA_BARS = 240;
/** Slippage cap on every order, 1% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

interface TidebreakState {
  /** Closes seen so far, oldest first (raw price units; ratios are scale-free). */
  closes: number[];
  /** Highest close since the current entry, or null while flat. */
  peak: number | null;
  /** Seq of the last exit, for the cooling-off rule. */
  lastExitSeq: number;
  /** Whether the anchor buy has ever been placed (it goes on the first tradeable batch). */
  entered: boolean;
  /** A sell is on its way out: keep retrying it until the position is gone. */
  exiting: boolean;
}

const state: TidebreakState = { closes: [], peak: null, lastExitSeq: -1000000, entered: false, exiting: false };

/** The mean of the last SMA_BARS closes, or null before that many bars. */
function slowAverage(): number | null {
  if (state.closes.length < SMA_BARS) return null;
  let sum = 0;
  for (let i = state.closes.length - SMA_BARS; i < state.closes.length; i++) sum += state.closes[i]!;
  return sum / SMA_BARS;
}

/** The return over the last `bars` closes, in basis points, or null. */
function momentumBps(bars: number): number | null {
  if (state.closes.length <= bars) return null;
  const now = state.closes[state.closes.length - 1]!;
  const then = state.closes[state.closes.length - 1 - bars]!;
  if (then === 0) return null;
  return ((now - then) / then) * 10000;
}

/** Fold one bar into the series this bot's rules read. */
function push(bar: Bar): void {
  state.closes.push(Number(bar.c));
}

await runBars({
  onBatch(botState: BarsState, batch) {
    const symbol = botState.hello.symbols[0]!.symbol;
    for (const bar of batch.bars) push(bar);

    // Warm-up batches carry bars from before the scored window: build the
    // history from them, but send no order (the replay would reject it).
    if (botState.warmingUp) return [];

    const held = botState.positions.get(symbol);
    const close = botState.close(symbol);
    if (close === null) return [];
    const closeNum = Number(close);

    const orders: (BuyInput | SellInput)[] = [];

    // A buy the market refused (no bar, slippage past the cap) is tried
    // again on the next batch instead of being forgotten.
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'rejected') state.entered = false;
    }

    if (held !== undefined) {
      // Still holding after a sell was sent: the market refused it, so send
      // it again with the peak frozen — the guard still holds.
      if (state.exiting) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        return orders;
      }
      // Holding: raise the peak, and exit on the trailing guard.
      if (state.peak === null || closeNum > state.peak) state.peak = closeNum;
      if (state.peak !== null && closeNum * 10000 <= state.peak * (10000 - TRAIL_BPS)) {
        orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        state.exiting = true;
      }
      return orders;
    }

    // Flat again after an exit: the cooling-off starts now.
    if (state.exiting) {
      state.exiting = false;
      state.peak = null;
      state.lastExitSeq = botState.seq;
    }

    // Flat: the anchor buys on the first tradeable batch (seq 0, or the
    // first batch after a warm-up); afterwards only a proven recovery,
    // after the cooling-off, earns a re-entry.
    if (!state.entered) {
      if (botState.cash >= BigInt(botState.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol, notional_quote_units: botState.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
        state.peak = closeNum;
        state.entered = true;
      }
      return orders;
    }

    if (botState.seq - state.lastExitSeq < COOLDOWN_BARS) return [];
    const sma = slowAverage();
    const mom = momentumBps(REENTRY_MOM_BARS);
    if (sma === null || mom === null) return [];
    if (closeNum * 10000 > sma * (10000 + REENTRY_ABOVE_SMA_BPS) && mom > REENTRY_MOM_BPS) {
      if (botState.cash >= BigInt(botState.hello.fees.min_notional_quote_units)) {
        orders.push({ side: 'buy', symbol, notional_quote_units: botState.cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
        state.peak = closeNum;
      }
    }
    return orders;
  },
});
