import { createInterface } from "node:readline";

type Bar = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: null;
  o_depth: string[];
  c_depth: string[];
};

type Position = {
  symbol: string;
  qty: string;
  cost_quote_units: string;
};

type Account = {
  cash_quote_units: string;
  positions: Position[];
  equity_quote_units: string;
};

type Fill = {
  client_id: string;
  symbol: string;
  side: string;
  status: string;
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
};

type Message = {
  type: string;
  protocol?: string;
  seed?: string;
  symbols?: { symbol: string; mint: string; price_scale: number; qty_scale: number }[];
  warmup_count?: number;
  seq?: number;
  t?: number;
  bars?: Bar[];
  fills?: Fill[];
  account?: Account;
};

type Order =
  | { side: "buy"; client_id: string; symbol: string; notional_quote_units: string; max_slippage_bps: number }
  | { side: "sell"; client_id: string; symbol: string; qty: string; max_slippage_bps: number };

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let symbol = "";
let fast = 0;
let slow = 0;
let fastCount = 0;
let slowCount = 0;
let previousFast = 0;
let previousSlow = 0;
let havePrevious = false;
let entryReference = 0;
let pendingEntryReference = 0;
let retryEntry = false;
let nextBuyId = 0;
let nextSellId = 0;

function reply(seq: number, orders: Order[]): void {
  process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
}

function parseUnits(value: string): bigint {
  return BigInt(value);
}

input.on("line", (line: string) => {
  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    return;
  }

  if (message.type === "hello") {
    symbol = message.symbols?.[0]?.symbol ?? "";
    // Warm-up bars without prices cannot seed either average.
    return;
  }

  if (message.type === "done") {
    input.close();
    return;
  }

  if (message.type !== "batch") return;

  const seq = message.seq ?? 0;
  const account = message.account;
  const bars = message.bars ?? [];
  const bar = bars.find((candidate) => candidate.symbol === symbol);
  if (!bar || !account) {
    reply(seq, []);
    return;
  }

  const close = Number(bar.c) / 100000;
  fastCount += 1;
  slowCount += 1;

  if (fastCount <= 12) fast += (close - fast) / fastCount;
  else fast += (2 / 13) * (close - fast);
  if (slowCount <= 50) slow += (close - slow) / slowCount;
  else slow += (2 / 51) * (close - slow);

  const averagesReady = fastCount >= 12 && slowCount >= 50;
  const crossedUp = averagesReady && havePrevious && previousFast <= previousSlow && fast > slow;
  const aboveSlow = averagesReady && close > slow * 1.003;
  const positions = account.positions.filter((position) => position.symbol === symbol);
  const position = positions[0];
  const orders: Order[] = [];

  if (position) {
    entryReference = pendingEntryReference;
    const exit = fast < slow || close < entryReference * 0.992 || close > entryReference * 1.01;
    if (exit) {
      orders.push({
        side: "sell",
        client_id: "s-" + nextSellId++,
        symbol,
        qty: position.qty,
        max_slippage_bps: 100,
      });
    }
  } else {
    if (entryReference !== 0) entryReference = 0;
    if (retryEntry && fast <= slow) {
      retryEntry = false;
      pendingEntryReference = 0;
    }
    const entryAllowed = retryEntry
      ? fast > slow && aboveSlow
      : crossedUp && aboveSlow;
    const cash = parseUnits(account.cash_quote_units);
    if (entryAllowed && cash >= 1000000n) {
      orders.push({
        side: "buy",
        client_id: "b-" + nextBuyId++,
        symbol,
        notional_quote_units: cash.toString(),
        max_slippage_bps: 100,
      });
      pendingEntryReference = close;
      retryEntry = true;
    }
  }

  if (position) {
    retryEntry = false;
  }
  if (averagesReady) {
    previousFast = fast;
    previousSlow = slow;
    havePrevious = true;
  }
  reply(seq, orders);
});
