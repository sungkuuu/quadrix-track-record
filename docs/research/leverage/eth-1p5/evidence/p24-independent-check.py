#!/usr/bin/env python3
"""qETH1.5X P24 — independent recount of the days the daily level moved outside ±25%.

Written from the rulebook text only (rulebooks/qeth15.md §2 · §4 · §5 · §8 of this repository), without the
measurement script p24-daily-moves.mjs or the registered engine. Standard library only.

Model (a reading of §4):
- Book: collateral C (ETH value), debt D, equity E = C - D, λ = C / E. Each UTC day starts at λ 1.5 (C 1.5, D 0.5,
  E 1) at the previous day's last 15-minute close.
- Every 15-minute bar of the day, in order: debt accrues (1 + r/365)^(elapsed minutes / 1440) since the last close;
  liquidation if at the bar low D / (C · low/prev_close) >= 0.86 (equity 0); C moves to the close.
- At a close that is not the day's last bar: if λ >= 2.3, trade back to 1.5 (cost 30 bp of the traded notional).
- At the day's last bar close: trade back to 1.5 (reset) with the same cost.
- The day's move = day-end equity / 1.
- Marks: each mark moves at most 25% of the current share price (contract bound, inclusive); count the marks from
  1.000000 (6-decimal integers, as the contract) and, as a second count, the fewest moves of at most 24%.
Usage: python3 p24-independent-check.py <ethusdt-15m.csv.gz> [rate=0.045] [cost_bp=30]
"""
import sys, gzip, hashlib, math
from datetime import datetime, timedelta

path = sys.argv[1]
r = float(sys.argv[2]) if len(sys.argv) > 2 else 0.045
cost = (float(sys.argv[3]) if len(sys.argv) > 3 else 30.0) / 1e4
TARGET, TRIG, LLTV = 1.5, 2.3, 0.86
EXPECT = '323831dd73c6266320931fed8c5bf86fdb5df11ce05b1ee269a26eb33a7e6478'
raw = open(path, 'rb').read()
h = hashlib.sha256(raw).hexdigest()
print('input sha256', h, 'OK' if h == EXPECT else 'MISMATCH')

bars = []  # (datetime open, low, close)
for line in gzip.decompress(raw).decode().splitlines()[1:]:
    t, o, hi, lo, c, n = line.split(',')
    bars.append((datetime.strptime(t, '%Y-%m-%dT%H:%M'), float(lo), float(c)))

byday = {}
for b in bars:
    byday.setdefault(b[0].date(), []).append(b)
days = sorted(byday)

def rebalance(C, D):
    E = C - D
    N = abs(TARGET * E - C)
    E2 = E - cost * N
    return TARGET * E2, (TARGET - 1) * E2

start, end = datetime(2017, 9, 1).date(), datetime(2026, 9, 29).date()
moves = []
trig_days = set(); liq_days = []
for i, d in enumerate(days):
    if d < start or d > end:
        continue
    prev = days[i - 1]
    pb = byday[prev][-1]
    prev_close = pb[2]
    prev_close_time = pb[0] + timedelta(minutes=15)
    C, D = TARGET, TARGET - 1
    dead = False
    bl = byday[d]
    for j, (t, lo, cl) in enumerate(bl):
        close_time = t + timedelta(minutes=15)
        mins = (close_time - prev_close_time).total_seconds() / 60
        D *= (1 + r / 365) ** (mins / 1440)
        if D / (C * lo / prev_close) >= LLTV:
            dead = True; liq_days.append(d); break
        C *= cl / prev_close
        prev_close, prev_close_time = cl, close_time
        last = (j == len(bl) - 1)
        if last:
            C, D = rebalance(C, D)
        elif C / (C - D) >= TRIG:
            C, D = rebalance(C, D); trig_days.add(d)
    E = 0.0 if dead else C - D
    moves.append((d, E))

def marks_contract(ratio):
    # share price in 6-decimal units; each mark moves by at most old*2500/10000 (inclusive)
    p = 1_000_000
    tgt = round(p * ratio)
    n = 0
    while p != tgt:
        step = p * 2500 // 10000
        p = tgt if abs(tgt - p) <= step else (p + step if tgt > p else p - step)
        n += 1
    return n

def marks_24(ratio):
    return max(1, math.ceil(abs(math.log(ratio)) / math.log(1.24 if ratio > 1 else 1 / 0.76))) if ratio > 0 else None

out = [(d, e) for d, e in moves if e > 1.25 or e < 0.75]
print(f'rate {r} cost {cost*1e4:.0f}bp; days {len(moves)} ({moves[0][0]} → {moves[-1][0]}); trigger days {len(trig_days)} {sorted(trig_days)}; liquidations {liq_days}')
print(f'days outside ±25%: {len(out)} (since 2023-01-01: {sum(1 for d,_ in out if d.year >= 2023)})')
print('  ' + ' · '.join(f'{d} {100*(e-1):+.2f}%' for d, e in out))
big = max(moves, key=lambda x: abs(math.log(x[1])) if x[1] > 0 else 1e9)
print(f'largest: {big[0]} {100*(big[1]-1):+.2f}%; marks (contract bound, from 1.000000) {marks_contract(big[1])}; fewest ≤24% moves {marks_24(big[1])}')
from collections import Counter
print('marks by day (contract bound):', dict(Counter(marks_contract(e) for _, e in out)))
print('days |move| > 15%:', sum(1 for _, e in moves if abs(e - 1) > 0.15))
