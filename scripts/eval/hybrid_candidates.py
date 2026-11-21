#!/usr/bin/env python3
"""Vector and word+vector candidates at passage level, written as synthetic runs (free, local).

    HF_HUB_OFFLINE=1 <python with sentence-transformers> scripts/eval/hybrid_candidates.py \
        --db PKG/ai.db --lexical RUN_DIR --out-prefix OUT_PREFIX [--top 12] [--no-alias]

For every question of RUN_DIR/answers.jsonl a passage gets a vector score = the best cosine between the
question and any of: three-sentence windows of the passage text, each line of its search_alias (cards).
Writes two run directories measurable by scripts/eval/passage_coverage.py:
  OUT_PREFIX-vec  — top N passages by vector score;
  OUT_PREFIX-hyb  — reciprocal-rank fusion of the lexical run's passages (in their order) and the vector
                    ranking, top N.
The lexical run is not changed; manifest.json is copied so the measurement tool accepts the directory.
"""
import argparse
import json
import re
import shutil
import sqlite3
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

RRF_K = 60
SENT = re.compile(r'(?<=[.!?…])\s+')


def windows(text, size=3):
    sents = [s for s in SENT.split(' '.join(text.split())) if s.strip()]
    if len(sents) <= size:
        return [' '.join(sents)] if sents else []
    return [' '.join(sents[i:i + size]) for i in range(0, len(sents) - size + 1, 2)]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--db', required=True), ap.add_argument('--lexical', required=True)
    ap.add_argument('--out-prefix', required=True), ap.add_argument('--top', type=int, default=12)
    ap.add_argument('--no-alias', action='store_true')
    ap.add_argument('--model', default='sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2')
    args = ap.parse_args()
    con = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True)
    rows = con.execute('select chunk_id, content, coalesce(search_alias, "") from chunks order by unit_id, ord').fetchall()
    con.close()
    ids, texts, owner = [r[0] for r in rows], [], []
    for i, (_, content, alias) in enumerate(rows):
        pieces = windows(content) + ([] if args.no_alias else [s for s in alias.split('\n') if s.strip()])
        texts += pieces
        owner += [i] * len(pieces)
    model = SentenceTransformer(args.model, device='cpu')
    vecs = model.encode(texts, batch_size=64, normalize_embeddings=True, convert_to_numpy=True)
    owner = np.array(owner)
    lex_dir = Path(args.lexical)
    answers = [json.loads(line) for line in (lex_dir / 'answers.jsonl').open(encoding='utf-8')]
    qvecs = model.encode([a['question'] for a in answers], batch_size=64, normalize_embeddings=True,
                         convert_to_numpy=True)
    outs = {}
    for kind in ('vec', 'hyb'):
        d = Path(f'{args.out_prefix}-{kind}')
        d.mkdir(parents=True)
        shutil.copy(lex_dir / 'manifest.json', d / 'manifest.json')
        outs[kind] = (d / 'answers.jsonl').open('w', encoding='utf-8')
    for a, q in zip(answers, qvecs):
        scores = np.full(len(ids), -2.0, dtype=np.float32)
        np.maximum.at(scores, owner, vecs @ q)
        vec_order = [ids[i] for i in np.argsort(-scores, kind='stable')]
        fused = {}
        for rank, cid in enumerate(a.get('chunk_ids') or []):
            fused[cid] = fused.get(cid, 0) + 1 / (RRF_K + rank + 1)
        for rank, cid in enumerate(vec_order[:args.top * 3]):
            fused[cid] = fused.get(cid, 0) + 1 / (RRF_K + rank + 1)
        hyb = sorted(fused, key=lambda c: -fused[c])[:args.top]
        for kind, chosen in (('vec', vec_order[:args.top]), ('hyb', hyb)):
            outs[kind].write(json.dumps({**a, 'chunk_ids': chosen}, ensure_ascii=False) + '\n')
    for f in outs.values():
        f.close()
    print(json.dumps({'passages': len(ids), 'vectors': len(texts), 'questions': len(answers)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
