#!/usr/bin/env python3
"""Self-test for realized_b.py: synthetic inputs, closed forms, determinism, hash chain, gap handling."""
import datetime
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from decimal import Decimal, getcontext

HERE = os.path.dirname(os.path.abspath(__file__))
PROG = os.path.join(HERE, 'realized_b.py')
getcontext().prec = 60
EPOCH = datetime.date(1970, 1, 1)
ONE = datetime.timedelta(days=1)


def write_day(dirp, d, close, drop=(), all_empty=False):
    start = (d - EPOCH).days * 86400000
    rows = []
    for m in range(1440):
        if all_empty or m in drop:
            continue
        c = close if m == max(set(range(1440)) - set(drop)) else '150.12500000'
        rows.append('%d,100.00000000,%s,99.50000000,%s\n' % (start + m * 60000, '210.00000000', c))
    with open(os.path.join(dirp, 'btcusdt-1m-%s.csv' % d.isoformat()), 'w') as f:
        f.write(''.join(rows))


def canon_sha(d, close, drop=(), all_empty=False):
    start = (d - EPOCH).days * 86400000
    ms = [m for m in range(1440) if not (all_empty or m in drop)]
    txt = ''.join('%d,100,210,99.5,%s\n' % (start + m * 60000, ('150.125' if m != ms[-1] else str(int(Decimal(close))))) for m in ms)
    return hashlib.sha256(txt.encode()).hexdigest()


def run(dirp, d0, d1, out, acc=None):
    cmd = [sys.executable, PROG, '--daily', dirp, '--from', d0, '--to', d1, '--out', out]
    if acc:
        cmd += ['--accepted-gaps', acc]
    return subprocess.run(cmd, capture_output=True, text=True)


def closed_form(closes):
    S = sum(((closes[i] / closes[i - 1]).ln()) ** 2 for i in range(1, len(closes)))
    var = Decimal(365) / Decimal(30) * S
    return var, 100 * var.sqrt()


def rel(a, b):
    return abs(Decimal(a) - b) / b


def check_chain(lines):
    prev = None
    for ln in lines:
        assert ln.endswith('\n')
        body, hs = ln[:-1].rsplit(',"hash":"', 1)
        h = hs[:-2]
        assert hashlib.sha256((body + '}').encode()).hexdigest() == h
        assert json.loads(ln)['prevHash'] == prev
        prev = h


def main():
    tmp = tempfile.mkdtemp()
    d0 = datetime.date(2026, 1, 1)
    n = 80
    dates = [d0 + datetime.timedelta(days=i) for i in range(n)]
    # Case 1: closes alternate 100, 200 -> every return is +-ln2
    c1 = ['100.00000000' if i % 2 == 0 else '200.00000000' for i in range(n)]
    dir1 = os.path.join(tmp, 'c1'); os.mkdir(dir1)
    for d, c in zip(dates, c1):
        write_day(dir1, d, c)
    out1, out1b = os.path.join(tmp, 'o1.jsonl'), os.path.join(tmp, 'o1b.jsonl')
    r = run(dir1, '2026-02-01', '2026-03-10', out1)
    assert r.returncode == 0, r.stderr
    lines = open(out1).read().splitlines(True)
    assert len(lines) == 38, len(lines)
    ln2 = Decimal(2).ln()
    exp_var = Decimal(365) * ln2 * ln2
    exp_val = 100 * exp_var.sqrt()
    for ln in lines:
        rec = json.loads(ln)
        assert rel(repr(rec['value']), exp_val) < Decimal('1e-12'), rec['value']
        assert rel(repr(rec['variance']), exp_var) < Decimal('1e-12')
        assert rec['returns'] == 30 and len(rec['window']) == 31 and 'late' not in rec
    check_chain(lines)
    first = json.loads(lines[0])
    assert list(first)[:6] == ['seq', 'date', 'observedAt', 'index', 'value', 'variance']
    assert 'sources' in first and 'sources' not in json.loads(lines[1])
    assert first['window'][0][0] == '2025-12-31' or first['window'][0][0] == '2026-01-01'
    # Case 2: irregular closes, closed form from decimal ln of the decimal strings
    c2, x = [], 123456789
    for i in range(n):
        x = (x * 1103515245 + 12345) % (2 ** 31)
        c2.append('%d.%08d' % (30000 + x % 40000, x % 100000000))
    dir2 = os.path.join(tmp, 'c2'); os.mkdir(dir2)
    for d, c in zip(dates, c2):
        write_day(dir2, d, c)
    out2 = os.path.join(tmp, 'o2.jsonl')
    assert run(dir2, '2026-02-01', '2026-03-10', out2).returncode == 0
    for ln in open(out2):
        rec = json.loads(ln)
        D = datetime.date.fromisoformat(rec['date'])
        idx = (D - d0).days
        cl = [Decimal(c2[i]) for i in range(idx - 31, idx)]
        var, val = closed_form(cl)
        assert rel(repr(rec['value']), val) < Decimal('1e-12'), (rec['date'], rec['value'], val)
        assert rel(repr(rec['variance']), var) < Decimal('1e-12')
    # Determinism
    assert run(dir1, '2026-02-01', '2026-03-10', out1b).returncode == 0
    assert open(out1, 'rb').read() == open(out1b, 'rb').read()
    # Day not ended: --to beyond the last file -> exit 0, lines only up to the last D whose own day file exists
    out3 = os.path.join(tmp, 'o3.jsonl')
    r = run(dir1, '2026-03-15', '2026-04-30', out3)
    assert r.returncode == 0 and r.stderr, (r.returncode, r.stderr)
    assert len(open(out3).readlines()) == 80 - 73 - 0, len(open(out3).readlines())
    # Gap: 1,439 rows on 2026-02-10 -> halt without acceptance, continue with it
    dirg = os.path.join(tmp, 'g'); os.mkdir(dirg)
    for d, c in zip(dates, c1):
        if d.isoformat() == '2026-02-10':
            write_day(dirg, d, c, drop={700})
        elif d.isoformat() == '2026-02-12':
            write_day(dirg, d, c, all_empty=True)
        else:
            write_day(dirg, d, c)
    outg = os.path.join(tmp, 'og.jsonl')
    r = run(dirg, '2026-02-01', '2026-03-10', outg)
    assert r.returncode == 1 and r.stderr.strip(), (r.returncode, r.stderr)
    got = open(outg).readlines()
    assert len(got) == 10 and json.loads(got[-1])['date'] == '2026-02-10', len(got)  # line 02-11 needs day 02-10
    shas = [canon_sha(datetime.date(2026, 2, 10), c1[40], drop={700})]
    accp = os.path.join(tmp, 'acc.json')
    json.dump([{'id': 'ACC-1', 'sha256': shas[0]}], open(accp, 'w'))
    r = run(dirg, '2026-02-01', '2026-03-10', outg, accp)
    assert r.returncode == 1 and '2026-02-12' in r.stderr, r.stderr
    json.dump([{'id': 'ACC-1', 'sha256': shas[0]}, hashlib.sha256(b'').hexdigest()], open(accp, 'w'))
    r = run(dirg, '2026-02-01', '2026-03-10', outg, accp)
    assert r.returncode == 0, r.stderr
    gl = open(outg).readlines()
    check_chain(gl)
    byd = {json.loads(l)['date']: json.loads(l) for l in gl}
    assert byd['2026-02-11']['gapAccepted'] == 'ACC-1' and byd['2026-02-11']['gaps'] == [['11:40', '11:40']]
    assert byd['2026-02-13']['gaps'] == [['00:00', '23:59']]
    w = {k: v for k, v in byd['2026-02-14']['window']}
    assert w['2026-02-12'] is None and byd['2026-02-14']['returns'] == 29
    # gap-aware closed form for D=2026-02-20: empty day 02-12 contributes zero return
    D = datetime.date(2026, 2, 20); idx = (D - d0).days
    closes = {}
    for i in range(idx - 31, idx):
        closes[i] = None if dates[i].isoformat() == '2026-02-12' else Decimal(c1[i])
    prev, S = closes[idx - 31], Decimal(0)
    for i in range(idx - 30, idx):
        if closes[i] is None:
            continue
        S += (closes[i] / prev).ln() ** 2
        prev = closes[i]
    val = 100 * (Decimal(365) / Decimal(30) * S).sqrt()
    assert rel(repr(byd['2026-02-20']['value']), val) < Decimal('1e-12')
    print('selftest OK')


if __name__ == '__main__':
    main()
