#!/usr/bin/env python3
"""Make an experimental copy of a knowledge package with search cards in `chunks.search_alias` (free, local).

    python3 scripts/eval/apply_search_cards.py SRC_PACKAGE_DIR CARDS.jsonl DST_PACKAGE_DIR [--fields questions,phrasings]

A search card is one JSON line per chunk: {"chunk_id": ..., "questions": [...], "phrasings": [...]} — the
questions a reader would ask in everyday words that the chunk answers. The card text is appended to the chunk's
`search_alias` (the package's enrichment field, already part of the full-text index through the view
`chunks_fts_src`) and the index is rebuilt. `content` — what the answering model reads — is never touched.
The source package is not modified; the destination must not exist. The copy is an experiment artefact: it is
not a release package and its manifests still describe the source.
"""
import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("src"), ap.add_argument("cards"), ap.add_argument("dst")
    ap.add_argument("--fields", default="questions,phrasings")
    args = ap.parse_args()
    src, dst, cards_path = Path(args.src), Path(args.dst), Path(args.cards)
    fields = [f for f in args.fields.split(",") if f]
    if not (src / "ai.db").is_file():
        print(f"no ai.db in {src}", file=sys.stderr)
        return 2
    if dst.exists():
        print(f"destination exists: {dst}", file=sys.stderr)
        return 2
    cards = {}
    for n, line in enumerate(cards_path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        card = json.loads(line)
        if card["chunk_id"] in cards:
            print(f"duplicate chunk_id on line {n}: {card['chunk_id']}", file=sys.stderr)
            return 2
        cards[card["chunk_id"]] = card
    shutil.copytree(src, dst)
    con = sqlite3.connect(dst / "ai.db")
    try:
        known = {row[0]: row[1] or "" for row in con.execute("select chunk_id, search_alias from chunks")}
        unknown = sorted(set(cards) - set(known))
        if unknown:
            print(f"cards for unknown chunks: {unknown[:5]} ({len(unknown)} total)", file=sys.stderr)
            shutil.rmtree(dst)
            return 2
        added_chars = 0
        for chunk_id, card in cards.items():
            text = "\n".join(s.strip() for f in fields for s in card.get(f, []) if s and s.strip())
            if not text:
                continue
            alias = f"{known[chunk_id]}\n{text}" if known[chunk_id] else text
            con.execute("update chunks set search_alias = ? where chunk_id = ?", (alias, chunk_id))
            added_chars += len(text)
        con.execute("insert into chunks_fts(chunks_fts) values('rebuild')")
        con.commit()
    finally:
        con.close()
    note = {"source": str(src), "cards": str(cards_path),
            "cards_sha256": hashlib.sha256(cards_path.read_bytes()).hexdigest(), "fields": fields,
            "chunks_total": len(known), "chunks_with_cards": len(cards), "chunks_without_cards": len(known) - len(cards),
            "added_chars": added_chars}
    (dst / "search-cards-applied.json").write_text(json.dumps(note, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(note, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
