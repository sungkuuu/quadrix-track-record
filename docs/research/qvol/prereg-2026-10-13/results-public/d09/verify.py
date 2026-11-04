import json, sys, os
R = sys.argv[1] if len(sys.argv) > 1 else '..'  # prereg folder; the verifier's original line held an absolute local path (original file sha256 800360945a5a4ac3254098745db9e23d3c5379c559979af24005001d7395278d), only this line was changed when the script was added to the results folder
RES = R + '/results-2026-11-03'
def load(p):
    out = []
    with open(p, encoding='utf-8') as f:
        for ln in f:
            ln = ln.strip()
            if ln: out.append(json.loads(ln))
    return out
def by_date(recs):
    d = {}
    for r in recs:
        assert r['date'] not in d, ('dup', r['date'])
        d[r['date']] = r
    return d
def rel(a, b):
    if a is None or b is None: return 1.0 if (a is None) != (b is None) else 0.0
    if a == 0 and b == 0: return 0.0
    if a == 0 or b == 0: return 1.0
    return abs(a - b) / max(abs(a), abs(b))
def js(v):  # JSON.stringify-equivalent for parsed values (no spaces)
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False)

def v1(aP, bP, lo, hi, label):
    A = by_date([r for r in load(aP) if lo <= r['date'] <= hi])
    B = by_date([r for r in load(bP) if lo <= r['date'] <= hi])
    onlyA = sorted(set(A) - set(B)); onlyB = sorted(set(B) - set(A))
    both = sorted(set(A) & set(B))
    mv = mvar = 0.0; nv = nvar = 0
    for d in both:
        a, b = A[d], B[d]
        rv = rel(a['value'], b['value']); rr = rel(a['variance'], b['variance'])
        mv = max(mv, rv); mvar = max(mvar, rr)
        if rv > 1e-9: nv += 1
        if rr > 1e-9: nvar += 1
    print(f'V1 {label}: A lines {len(A)} B lines {len(B)} compared {len(both)} onlyA {len(onlyA)} onlyB {len(onlyB)} '
          f'maxValueRel {mv!r} maxVarRel {mvar!r} >1e-9 value {nv} variance {nvar}')
    return A, B

def v2(A, B, label, snap=None):
    mism = 0; n = 0
    for d in sorted(set(A) & set(B)):
        n += 1
        if A[d]['source']['sha256'] != B[d]['source']['sha256']: mism += 1
    firstA = A[min(A)]; firstB = B[min(B)]
    sa = firstA.get('sources'); sb = firstB.get('sources')
    # compare day+sha256 (ignore trailing acceptance id if present)
    norm = lambda s: [(x[0], x[1], x[2]) for x in s]
    srcEq = norm(sa) == norm(sb)
    print(f'V2 {label}: per-line source.sha256 compared {n} mismatches {mism}; first-line sources A {len(sa)} B {len(sb)} equal(day,rows,sha) {srcEq}')
    if snap:
        S = {}
        for ln in open(snap):
            p = ln.split()
            if len(p) >= 3: S[p[0]] = p[2]
        m = 0; c = 0; missing = 0
        for d in sorted(A):
            day = A[d]['source']['day']
            if day not in S: missing += 1; continue
            c += 1
            if A[d]['source']['sha256'] != S[day]: m += 1
        # first-line sources vs snapshot
        m2 = 0; c2 = 0
        for x in sa:
            if x[0] in S:
                c2 += 1
                if x[2] != S[x[0]]: m2 += 1
        print(f'V2 REST vs snapshot canonical-1m.sha256: source days compared {c} mismatches {m} notInSnapshot {missing}; first-line sources compared {c2} mismatches {m2}; snapshot days {len(S)}')

K = ['date','index','value','variance','window','returns','carriedFrom','gaps','gapAccepted','source.day','source.rows','source.sha256','source.lastBar','rule']
def getk(r, k):
    if k.startswith('source.'):
        return r['source'].get(k[7:], '__absent__')
    return r.get(k, '__absent__')
def v4(p1, p2, label, lo, hi):
    A = by_date([r for r in load(p1) if lo <= r['date'] <= hi])
    B = by_date([r for r in load(p2) if lo <= r['date'] <= hi])
    assert set(A) == set(B), 'date sets differ'
    mism = 0; fields = {}
    for d in A:
        a, b = A[d], B[d]
        bad = [k for k in K if js(getk(a,k)) != js(getk(b,k))]
        if js(a.get('seq')) != js(b.get('seq')): bad.append('seq')
        if js(a.get('sources','__absent__')) != js(b.get('sources','__absent__')): bad.append('sources')
        if bad:
            mism += 1
            for k in bad: fields[k] = fields.get(k, 0) + 1
    print(f'V4 {label}: lines {len(A)} mismatched lines {mism} by field {fields}')

FS = RES + '/file-section'; RS = RES + '/rest-section'
print('== V1')
Af, Bf = v1(FS + '/a-run4/record-qvol.jsonl', FS + '/b-run1/record.jsonl', '2017-09-18', '2026-09-29', 'file (a-run4 vs b-run1)')
Ar, Br = v1(RS + '/a-rest/record-qvol.jsonl', RS + '/b-rest/record.jsonl', '2026-09-01', '2026-11-02', 'REST (a-rest vs b-rest)')
# pre-registration lines counted apart
pf = [d for d in Af if '2025-09-02' <= d <= '2026-09-29']; pr = [d for d in Ar if '2026-09-01' <= d <= '2026-10-06']
print(f'pre-registration lines counted apart: file {len(pf)} REST {len(pr)}')
print('== V2')
v2(Af, Bf, 'file')
v2(Ar, Br, 'REST', snap=R + '/snapshot/E-2026-11-02/canonical-1m.sha256')
print('== V4')
v4(FS + '/a-run4/record-qvol.jsonl', FS + '/a-run5/record-qvol.jsonl', 'a-run4 vs a-run5 (both v22.23.1, containers X/Y)', '2017-09-18', '2026-09-29')
v4(FS + '/a-run1/record-qvol.jsonl', FS + '/a-run4/record-qvol.jsonl', 'INFO a-run1 (v22.23.4) vs a-run4 (v22.23.1)', '2017-09-18', '2026-09-29')
print('== raw line counts / out-of-range')
for p in [FS+'/a-run4/record-qvol.jsonl', FS+'/a-run5/record-qvol.jsonl', FS+'/a-run1/record-qvol.jsonl', FS+'/b-run1/record.jsonl', RS+'/a-rest/record-qvol.jsonl', RS+'/b-rest/record.jsonl']:
    L = load(p); print(os.path.relpath(p, RES), len(L), 'first', L[0]['date'], 'last', L[-1]['date'])
