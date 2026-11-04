#!/usr/bin/env python3
"""Implementation B of the qVOL realized-volatility line (written from the definition text only)."""
import argparse
import datetime
import hashlib
import json
import math
import os
import re
import sys

DAY_MS = 86400000
MIN_MS = 60000
EPOCH = datetime.date(1970, 1, 1)
RE_INT = re.compile(r'^[0-9]+$')
RE_DEC = re.compile(r'^[0-9]+(\.[0-9]+)?$')


class Halt(Exception):
    """Stop with exit code 1 (nothing more is written)."""


class NotEnded(Exception):
    """The day is not over yet: stop with exit code 0."""


def js_num(x):
    """ECMAScript Number->String (shortest round trip)."""
    x = float(x)
    if x != x or x in (float('inf'), float('-inf')):
        raise Halt('non-finite number')
    if x == 0:
        return '0'
    sign = '-' if x < 0 else ''
    r = repr(abs(x))
    if 'e' in r:
        m, e = r.split('e')
        e = int(e)
    else:
        m, e = r, 0
    ip, _, fp = m.partition('.')
    allv = ip + fp
    point = len(ip) + e
    stripped = allv.lstrip('0')
    point -= len(allv) - len(stripped)
    digits = stripped.rstrip('0')
    k, n = len(digits), point
    if k <= n <= 21:
        s = digits + '0' * (n - k)
    elif 0 < n <= 21:
        s = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0:
        s = '0.' + '0' * (-n) + digits
    else:
        ex = n - 1
        es = ('+' if ex >= 0 else '-') + str(abs(ex))
        s = (digits + 'e' + es) if k == 1 else (digits[0] + '.' + digits[1:] + 'e' + es)
    return sign + s


def dumps(v):
    """JSON.stringify-like: no spaces, key order kept, numbers per ECMAScript."""
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return js_num(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return '[' + ','.join(dumps(i) for i in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + dumps(x) for k, x in v.items()) + '}'
    raise TypeError(type(v))


def day_start_ms(d):
    return (d - EPOCH).days * DAY_MS


def iso_ms(ms):
    d = EPOCH + datetime.timedelta(days=ms // DAY_MS)
    t = ms % DAY_MS
    return '%sT%02d:%02d:%02d.%03dZ' % (d.isoformat(), t // 3600000, t // 60000 % 60, t // 1000 % 60, t % 1000)


def hhmm(minute):
    return '%02d:%02d' % (minute // 60, minute % 60)


def load_accepted(path):
    """Accepted list: {canonical-text sha256 -> id or None}."""
    acc = {}
    if not path:
        return acc
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if isinstance(data, dict):
        for key in ('accepted', 'entries'):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            data = [{'id': k, 'sha256': v} if isinstance(v, str) else dict(v, id=v.get('id', k))
                    for k, v in data.items()]
    if not isinstance(data, list):
        raise Halt('accepted-gaps file: unsupported shape')
    for e in data:
        if isinstance(e, str):
            acc[e.lower()] = None
        elif isinstance(e, dict) and isinstance(e.get('sha256'), str):
            acc[e['sha256'].lower()] = e.get('id')
        else:
            raise Halt('accepted-gaps file: unsupported entry')
    return acc


class Days:
    def __init__(self, directory, accepted):
        self.dir = directory
        self.accepted = accepted
        self.cache = {}

    def get(self, d):
        if d in self.cache:
            return self.cache[d]
        path = os.path.join(self.dir, 'btcusdt-1m-%s.csv' % d.isoformat())
        s = self._load(d, path) if os.path.isfile(path) else None
        self.cache[d] = s
        return s

    def _load(self, d, path):
        with open(path, 'rb') as f:
            raw = f.read()
        try:
            text = raw.decode('utf-8')
        except UnicodeDecodeError:
            raise Halt('%s: not UTF-8' % path)
        lines = text.split('\n') if text else []
        if lines and lines[-1] == '':
            lines.pop()
        start = day_start_ms(d)
        canon = []
        prev = None
        opens = []
        last_close = None
        for i, ln in enumerate(lines):
            f = ln.split(',')
            if len(f) != 5 or not RE_INT.match(f[0]) or not all(RE_DEC.match(x) for x in f[1:]):
                raise Halt('%s line %d: malformed row' % (path, i + 1))
            ot = int(f[0])
            if not (start <= ot < start + DAY_MS):
                raise Halt('%s line %d: openTime outside the UTC day' % (path, i + 1))
            if prev is not None and ot <= prev:
                raise Halt('%s line %d: openTime not strictly ascending' % (path, i + 1))
            prev = ot
            nums = [float(x) for x in f[1:]]
            canon.append('%d,%s,%s,%s,%s\n' % (ot, *[js_num(x) for x in nums]))
            opens.append(ot)
            last_close = nums[3]
        if last_close is not None and not last_close > 0:
            raise Halt('%s: non-positive close' % path)
        sha = hashlib.sha256(''.join(canon).encode('utf-8')).hexdigest()
        gaps = []
        if len(opens) != 1440:
            present = set((o - start) // MIN_MS for o in opens if (o - start) % MIN_MS == 0)
            m = 0
            while m < 1440:
                if m in present:
                    m += 1
                    continue
                a = m
                while m + 1 < 1440 and (m + 1) not in present:
                    m += 1
                gaps.append([hhmm(a), hhmm(m)])
                m += 1
        return {'date': d, 'rows': len(opens), 'sha': sha, 'close': last_close,
                'lastBar': hhmm((opens[-1] - start) // MIN_MS) if opens else None,
                'firstOpen': opens[0] if opens else None, 'gaps': gaps}

    def need(self, d):
        """Day summary that must exist and be complete (1,440 rows) or accepted. Returns (summary, accept-id-or-None, accepted?)."""
        s = self.get(d)
        if s is None:
            raise Halt('input file for %s is missing' % d.isoformat())
        if s['rows'] == 1440:
            return s, None, False
        if s['sha'] in self.accepted:
            return s, self.accepted[s['sha']], True
        raise Halt('%s has %d rows (not 1440) and its canonical-text sha256 %s is not in the accepted list'
                   % (d.isoformat(), s['rows'], s['sha']))


def compute(directory, d_from, d_to, accepted):
    days = Days(directory, accepted)
    out = []
    prev_hash = None
    one = datetime.timedelta(days=1)
    D = d_from
    status = 0
    reason = None
    try:
        while D <= d_to:
            # day end: first bar opened at/after D 00:00 must exist (files of D, D+1, ... until one is missing)
            final_open = None
            k = D
            while final_open is None:
                s = days.get(k)
                if s is None:
                    raise NotEnded('%s has not ended (no bar opened at or after its 00:00 is available)' % D.isoformat())
                final_open = s['firstOpen']
                k += one
            win = []
            for j in range(31, 0, -1):
                dd = D - datetime.timedelta(days=j)
                s, aid, acc = days.need(dd)
                win.append((dd, s, aid, acc))
            carried = None
            if win[0][1]['close'] is None:
                dd = win[0][0] - one
                while True:
                    s, aid, acc = days.need(dd)
                    if s['close'] is not None:
                        carried = (dd, s, aid, acc)
                        break
                    dd -= one
            closes = [w[1]['close'] for w in win]
            prev = carried[1]['close'] if carried else closes[0]
            S = 0.0
            for c in closes[1:]:
                if c is None:
                    continue
                r = math.log(c / prev)
                S = S + r * r
                prev = c
            variance = (365 / 30) * S
            value = 100 * math.sqrt(variance)
            n_ret = sum(1 for c in closes[1:] if c is not None)
            obs_ms = final_open + MIN_MS
            observed = iso_ms(obs_ms)
            first = len(out) == 0
            dm1 = win[-1]
            rec = {'seq': len(out), 'date': D.isoformat(), 'observedAt': observed, 'index': 'qvol',
                   'value': value, 'variance': variance}
            if observed[:10] > D.isoformat():
                rec['late'] = True
            rec['window'] = [[w[0].isoformat(), w[1]['close']] for w in win]
            if carried:
                cd, cs, caid, cacc = carried
                if first:
                    ent = [cd.isoformat(), cs['close'], cs['rows'], cs['sha']]
                    if caid is not None:
                        ent.append(caid)
                    rec['carriedFrom'] = ent
                else:
                    rec['carriedFrom'] = [cd.isoformat(), cs['close']]
            rec['returns'] = n_ret
            rec['source'] = {'host': 'data-api.binance.vision', 'symbol': 'BTCUSDT', 'interval': '1m',
                             'day': dm1[0].isoformat(), 'rows': dm1[1]['rows'], 'sha256': dm1[1]['sha'],
                             'lastBar': dm1[1]['lastBar'], 'finalBy': final_open, 'fetchedAt': None,
                             'via': 'offline'}
            if first:
                srcs = []
                for dd, s, aid, acc in win:
                    e = [dd.isoformat(), s['rows'], s['sha']]
                    if aid is not None:
                        e.append(aid)
                    srcs.append(e)
                rec['sources'] = srcs
            if dm1[1]['rows'] < 1440:
                rec['gaps'] = dm1[1]['gaps']
                rec['gapAccepted'] = dm1[2] if dm1[2] is not None else dm1[1]['sha']
            rec['rule'] = {'rulebookSha256': None, 'windowDays': 30, 'yearDays': 365,
                           'sampling': '1d-close-00:00-utc', 'mean': 'zero'}
            rec['keeper'] = {'lagSeconds': None, 'run': None}
            rec['prevHash'] = prev_hash
            h = hashlib.sha256(dumps(rec).encode('utf-8')).hexdigest()
            rec['hash'] = h
            prev_hash = h
            out.append(dumps(rec) + '\n')
            D += one
    except NotEnded as e:
        reason = str(e)
        status = 0
    except Halt as e:
        reason = 'HALT at %s: %s' % (D.isoformat(), e)
        status = 1
    return out, status, reason


def parse_date(s):
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError('bad date: %s' % s)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--daily', required=True)
    ap.add_argument('--from', dest='d_from', required=True, type=parse_date)
    ap.add_argument('--to', dest='d_to', required=True, type=parse_date)
    ap.add_argument('--out', required=True)
    ap.add_argument('--accepted-gaps', default=None)
    a = ap.parse_args(argv)
    if a.d_from > a.d_to:
        print('--from is after --to', file=sys.stderr)
        return 1
    try:
        acc = load_accepted(a.accepted_gaps)
        lines, status, reason = compute(a.daily, a.d_from, a.d_to, acc)
    except Halt as e:
        print('HALT: %s' % e, file=sys.stderr)
        return 1
    with open(a.out, 'wb') as f:
        f.write(''.join(lines).encode('utf-8'))
    if reason:
        print(reason, file=sys.stderr)
    return status


if __name__ == '__main__':
    sys.exit(main())
