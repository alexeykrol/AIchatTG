#!/usr/bin/env python3
"""Per-part retrieval ($0): split each question into parts by a fixed text rule (no gold hints),
retrieve for the whole question and for every part, merge round-robin into the same number of passages
as the whole-question run, so the context budget stays equal.

  split  DONOR OUT_DONORS_DIR            -> OUT/part1..partN donor copies (question = part k or whole)
  merge  WHOLE_RUN PART_RUN... OUT_RUN   -> synthetic retrieval run with merged chunk_ids
"""
import json, re, shutil, sys
from pathlib import Path

MAX_PARTS = 3
CLAUSE = re.compile(r',\s+|\s+(?:и|а|но|или|либо|хотя|однако|при этом)\s+|\s+—\s+|:\s+')

def parts_of(question):
    sents = [s.strip() for s in re.split(r'(?<=[.?!…])\s+', question) if s.strip()]
    out = []
    for s in sents:
        clauses = [c.strip(' ,.?!') for c in CLAUSE.split(s)]
        clauses = [c for c in clauses if len(c.split()) >= 3]
        if len(clauses) > 1:
            out.extend(clauses)
        elif len(s.split()) >= 3:
            out.append(s.strip())
    seen, uniq = set(), []
    for p in out:
        if p not in seen and p != question.strip():
            seen.add(p); uniq.append(p)
    return uniq[:MAX_PARTS]

def split(donor, outdir):
    donor, outdir = Path(donor), Path(outdir)
    cases = [json.loads(l) for l in (donor / 'evals/golden/cases.jsonl').open() if l.strip()]
    for k in range(1, MAX_PARTS + 1):
        d = outdir / f'part{k}'
        (d / 'evals/golden').mkdir(parents=True, exist_ok=True)
        (d / 'evals/baseline').mkdir(parents=True, exist_ok=True)
        shutil.copy(donor / 'evals/baseline/id_map.json', d / 'evals/baseline/id_map.json')
        with (d / 'evals/golden/cases.jsonl').open('w') as f:
            for c in cases:
                ps = parts_of(c['question'])
                c2 = dict(c); c2['question'] = ps[k - 1] if k <= len(ps) else c['question']
                f.write(json.dumps(c2, ensure_ascii=False) + '\n')
    with (outdir / 'parts.jsonl').open('w') as f:
        for c in cases:
            f.write(json.dumps({'case_id': c['id'], 'question': c['question'], 'parts': parts_of(c['question'])}, ensure_ascii=False) + '\n')

def rows(run):
    return {json.loads(l)['q']: json.loads(l) for l in (Path(run) / 'answers.jsonl').open() if l.strip()}

def merge(whole, part_runs, out):
    W = rows(whole); P = [rows(r) for r in part_runs]; out = Path(out)
    out.mkdir(parents=True); shutil.copy(Path(whole) / 'manifest.json', out / 'manifest.json')
    with (out / 'answers.jsonl').open('w') as f:
        for q, a in W.items():
            lists = [a.get('chunk_ids') or []] + [p[q].get('chunk_ids') or [] for p in P if p[q]['question'] != a['question']]
            budget = len(lists[0]); merged = []
            i = 0
            while len(merged) < budget and any(i < len(l) for l in lists):
                for l in lists:
                    if i < len(l) and l[i] not in merged and len(merged) < budget:
                        merged.append(l[i])
                i += 1
            a = dict(a); a['chunk_ids'] = merged; a['subqueries'] = len(lists) - 1
            f.write(json.dumps(a, ensure_ascii=False) + '\n')

if __name__ == '__main__':
    if sys.argv[1] == 'split': split(sys.argv[2], sys.argv[3])
    else: merge(sys.argv[2], sys.argv[3:-1], sys.argv[-1])
