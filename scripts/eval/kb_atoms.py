#!/usr/bin/env python3
"""Number the text of a knowledge package so that a marker can cut it by line numbers (free, local).

    python3 scripts/eval/kb_atoms.py PACKAGE_DIR OUT_DIR [--max-line 500]

An atom is one non-empty line of a record (a paragraph, a heading, a list item); a line longer than
--max-line characters is split at sentence ends. Chunks of one record are joined first and the text
repeated at a chunk joint is dropped, so every piece of the record appears exactly once.

Writes OUT_DIR/atoms.jsonl (one atom per line: unit_id, n, chunk_id, section_path, text, sep) and
OUT_DIR/units/<unit_id>.txt — the record as numbered lines `[0012] text` for a human or model marker.
The marker returns ranges of numbers; the verbatim text is always assembled by code from atoms.jsonl
(text + sep reproduce the record byte for byte — checked here before anything is written).
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

SENTENCE_END = re.compile(r'(?<=[.!?…»"])(\s+)(?=[«"(\[—–\-0-9A-ZА-ЯЁ])')


def dedup_joint(prev_text, text):
    """Drop the prefix of `text` that repeats the tail of `prev_text` (chunk overlap)."""
    for n in range(min(len(prev_text), len(text), 2000), 20, -1):
        if prev_text.endswith(text[:n]):
            return text[n:]
    return text


def split_line(line, max_line):
    """Yield (text, sep) pieces of one line; pieces never exceed max_line unless a sentence does."""
    if len(line) <= max_line:
        yield line, ''
        return
    parts = SENTENCE_END.split(line)  # [sentence, gap, sentence, gap, ...]
    buf, gap_after = '', ''
    for i in range(0, len(parts), 2):
        sentence, gap = parts[i], parts[i + 1] if i + 1 < len(parts) else ''
        if buf and len(buf) + len(gap_after) + len(sentence) > max_line:
            yield buf, gap_after
            buf = sentence
        else:
            buf = buf + gap_after + sentence if buf else sentence
        gap_after = gap
    if buf:
        yield buf, ''


def atoms_of(text, max_line):
    """Yield (text, sep): sep is the whitespace that follows the atom in the record."""
    pieces = re.split(r'(\n+)', text)  # [line, newlines, line, ...]
    pending = []
    for i in range(0, len(pieces), 2):
        line, newlines = pieces[i], pieces[i + 1] if i + 1 < len(pieces) else ''
        if not line.strip():
            if pending:
                pending[-1][1] += line + newlines
            else:
                pending.append(['', line + newlines])  # leading whitespace of the record
            continue
        split = [[t, s] for t, s in split_line(line, max_line)]
        split[-1][1] += newlines
        pending.extend(split)
    return pending


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('package'), ap.add_argument('out')
    ap.add_argument('--max-line', type=int, default=500)
    args = ap.parse_args()
    db, out = Path(args.package) / 'ai.db', Path(args.out)
    if not db.is_file():
        print(f'no ai.db in {args.package}', file=sys.stderr)
        return 2
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    titles = dict(con.execute('select unit_id, title from units'))
    rows = con.execute('select unit_id, chunk_id, section_path, content from chunks order by unit_id, ord').fetchall()
    con.close()
    atoms, units, prev = [], {}, None
    for unit_id, chunk_id, section_path, content in rows:
        own = dedup_joint(prev[1], content) if prev and prev[0] == unit_id else content
        prev = (unit_id, content)
        made = atoms_of(own, args.max_line)
        if ''.join(t + s for t, s in made) != own:
            print(f'round trip failed for {chunk_id}', file=sys.stderr)
            return 1
        for text, sep in made:
            unit = units.setdefault(unit_id, [])
            if not text:  # leading whitespace only: glue it to the previous atom of the record
                if unit:
                    unit[-1]['sep'] += sep
                continue
            unit.append({'unit_id': unit_id, 'n': len(unit) + 1, 'chunk_id': chunk_id,
                         'section_path': section_path or '', 'text': text, 'sep': sep})
    (out / 'units').mkdir(parents=True, exist_ok=True)
    with (out / 'atoms.jsonl').open('w', encoding='utf-8') as f:
        for unit_id, unit in units.items():
            for atom in unit:
                f.write(json.dumps(atom, ensure_ascii=False) + '\n')
            lines = [f'# {unit_id} — {titles.get(unit_id, "")}', '']
            lines += [f'[{a["n"]:04d}] {a["text"]}' for a in unit]
            (out / 'units' / f'{unit_id}.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
            atoms.extend(unit)
    sizes = sorted(len(a['text']) for a in atoms)
    print(json.dumps({'units': len(units), 'atoms': len(atoms), 'chars': sum(sizes),
                      'median': sizes[len(sizes) // 2], 'max': sizes[-1]}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
