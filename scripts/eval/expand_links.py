#!/usr/bin/env python3
# Usage: python3 scripts/eval/expand_links.py RUN_DIR OUT_DIR PKG/ai.db contradicts,qualifies[,continues,applies] MAX_EXTRA
"""Synthetic run: after each context passage, add passages linked to it by TYPES (max EXTRA per question)."""
import json, sqlite3, sys, shutil
from pathlib import Path
src, dst, db, types, extra = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4].split(','), int(sys.argv[5])
con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
nb = {}
for t, a, b in con.execute('select type, a_chunk_id, b_chunk_id from passage_links'):
    if t in types:
        nb.setdefault(a, []).append(b); nb.setdefault(b, []).append(a)
dst.mkdir(parents=True); shutil.copy(src / 'manifest.json', dst / 'manifest.json')
added_total = 0
with (dst / 'answers.jsonl').open('w') as out:
    for line in (src / 'answers.jsonl').open():
        a = json.loads(line); ids = list(a.get('chunk_ids') or []); added = []
        for cid in list(ids):
            for o in nb.get(cid, []):
                if o not in ids and o not in added and len(added) < extra:
                    added.append(o)
        a['chunk_ids'] = ids + added; added_total += len(added)
        out.write(json.dumps(a, ensure_ascii=False) + '\n')
print(dst.name, 'added', added_total)
