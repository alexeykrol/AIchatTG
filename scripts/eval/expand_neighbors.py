#!/usr/bin/env python3
# Usage: python3 scripts/eval/expand_neighbors.py RUN_DIR OUT_DIR PKG/ai.db WIDTH
"""Synthetic run: add +-W neighbour passages (same record, by ord) after each context passage."""
import json, sqlite3, sys, shutil
from pathlib import Path
src, dst, db, w = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], int(sys.argv[4])
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
rows = con.execute('select chunk_id, unit_id, ord from chunks order by unit_id, ord').fetchall()
order = {}; pos = {}
for cid, uid, o in rows:
    order.setdefault(uid, []).append(cid); pos[cid] = (uid, len(order[uid]) - 1)
dst.mkdir(parents=True)
shutil.copy(src / 'manifest.json', dst / 'manifest.json')
with (dst / 'answers.jsonl').open('w') as out:
    for line in (src / 'answers.jsonl').open():
        a = json.loads(line); seen = []
        for cid in a.get('chunk_ids') or []:
            uid, i = pos[cid]
            for j in range(i - w, i + w + 1):
                if 0 <= j < len(order[uid]) and order[uid][j] not in seen:
                    seen.append(order[uid][j])
        a['chunk_ids'] = seen
        out.write(json.dumps(a, ensure_ascii=False) + '\n')
