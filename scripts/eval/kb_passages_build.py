#!/usr/bin/env python3
"""Build an experimental passage-indexed copy of a knowledge package."""

import argparse
from collections import Counter, defaultdict
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
from statistics import median
import sys
import unicodedata


ALIAS_FIELDS = ("title", "gist", "questions", "phrasings")
LINK_TYPES = ("contradicts", "qualifies", "continues", "applies")
RANGE_FIELDS = {"unit_id": str, "from": int, "to": int}
CARD_FIELDS = {
    **RANGE_FIELDS, "title": str, "gist": str, "questions": list,
    "phrasings": list, "concepts": list,
}
ATOM_FIELDS = {"unit_id": str, "n": int, "chunk_id": str, "section_path": str,
               "text": str, "sep": str}
LINK_FIELDS = {"type": str, "subject": str, "a": dict, "b": dict,
               "reason": str, "question": str}
SIDE_FIELDS = {**RANGE_FIELDS, "says": str}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def section_slug(section):
    if not section:
        return "body"
    heading = unicodedata.normalize("NFKC", section.rsplit(" > ", 1)[-1])
    heading = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    return re.sub(r"\W+", "-", heading.lower()).strip("-")[:40].rstrip("-") or "sec"


def search_fields(content, title, section):
    search_text = content + "\n" + title + (f" > {section}" if section else "")
    return search_text, len(re.findall(r"\w+", content)) * 8 // 5, sha256(content.encode("utf-8"))


def valid_fields(row, fields, where, errors):
    if not isinstance(row, dict):
        errors.append(f"{where}: expected an object")
        return False
    before = len(errors)
    for key, expected in fields.items():
        value = row.get(key)
        # JSON booleans are not atom numbers.
        if type(value) is not expected:
            errors.append(f"{where}: {key} must be {expected.__name__}")
        elif expected is list and any(not isinstance(item, str) for item in value):
            errors.append(f"{where}: {key} must contain only strings")
    return len(errors) == before


def json_rows(path, hashes, errors):
    try:
        data = path.read_bytes()
    except OSError as exc:
        errors.append(str(exc))
        return
    hashes[str(path.resolve())] = sha256(data)
    for number, raw in enumerate(data.splitlines(), 1):
        where = f"{path}:{number}"
        try:
            yield where, json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError) as exc:
            errors.append(f"{where}: {exc}")


def load_source(database, hashes):
    hashes[str(database)] = sha256(database.read_bytes())
    with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as db:
        titles = dict(db.execute("SELECT unit_id, title FROM units"))
        chunks = {
            chunk_id: (unit_id, section or "")
            for chunk_id, unit_id, section in db.execute(
                "SELECT chunk_id, unit_id, section_path FROM chunks"
            )
        }
        states = defaultdict(set)
        for unit_id, state in db.execute("SELECT DISTINCT unit_id, state FROM chunks"):
            states[unit_id].add(state)
    return titles, chunks, states


def load_atoms(path, titles, chunks, hashes, errors):
    atoms = defaultdict(list)
    for where, atom in json_rows(path, hashes, errors):
        if not valid_fields(atom, ATOM_FIELDS, where, errors):
            continue
        unit = atom["unit_id"]
        if unit not in titles:
            errors.append(f"{where}: unknown record {unit!r}")
            continue
        record = atoms[unit]
        if atom["n"] != len(record) + 1:
            errors.append(f"{where}: expected atom {len(record) + 1}, got {atom['n']}")
        if chunks.get(atom["chunk_id"]) != (unit, atom["section_path"]):
            errors.append(f"{where}: source chunk does not match record and section")
        if not atom["text"].strip() or atom["sep"].strip():
            errors.append(f"{where}: expected nonblank text and a whitespace separator")
        record.append(atom)
    for unit in sorted(titles.keys() - atoms.keys()):
        errors.append(f"{path}: no atoms for record {unit!r}")
    return atoms


def valid_range(row, atoms, where, errors):
    unit, first, last = row["unit_id"], row["from"], row["to"]
    if unit not in atoms:
        errors.append(f"{where}: unknown record or record without atoms {unit!r}")
        return False
    if not 1 <= first <= last <= len(atoms[unit]):
        errors.append(f"{where}: range {first}..{last} is outside record {unit!r} "
                      f"(1..{len(atoms[unit])})")
        return False
    return True


def load_markup(paths, atoms, hashes, errors):
    cards = defaultdict(list)
    owners = {}
    for file_index, path in enumerate(paths):
        for where, row in json_rows(path, hashes, errors):
            if not valid_fields(row, CARD_FIELDS, where, errors):
                continue
            unit = row["unit_id"]
            if owners.setdefault(unit, file_index) != file_index:
                errors.append(f"{where}: record {unit!r} appears in multiple markup files")
            if valid_range(row, atoms, where, errors):
                cards[unit].append((where, row))
    for unit, record in atoms.items():
        expected = 1
        for where, card in cards[unit]:
            if card["from"] != expected:
                errors.append(f"{where}: expected range to start at {expected}, got {card['from']}")
            expected = card["to"] + 1
        if expected != len(record) + 1:
            errors.append(f"markup for {unit!r}: expected coverage through atom {len(record)}, "
                          f"ended at {expected - 1}")
    return {unit: [card for _, card in rows] for unit, rows in cards.items()}


def load_links(path, atoms, hashes, errors):
    links = []
    for where, row in json_rows(path, hashes, errors):
        if not isinstance(row, dict):
            valid_fields(row, LINK_FIELDS, where, errors)
            continue
        before = len(errors)
        valid_fields(row, LINK_FIELDS, where, errors)
        if isinstance(row.get("type"), str) and row["type"] not in LINK_TYPES:
            errors.append(f"{where}: unknown link type {row['type']!r}")
        for side in ("a", "b"):
            label = f"{where} ({side})"
            if isinstance(row.get(side), dict) and valid_fields(row[side], SIDE_FIELDS, label, errors):
                valid_range(row[side], atoms, label, errors)
        if len(errors) == before:
            links.append(row)
    return links


def verbatim(atoms):
    return "".join(atom["text"] + atom["sep"] for atom in atoms).rstrip()


def mechanical_cards(unit, atoms, limit, errors):
    # Treat heading runs and their first body atom as indivisible. A terminal
    # heading run must travel with the preceding atom to avoid an orphan.
    blocks = []
    start = 0
    for index, atom in enumerate(atoms):
        if not atom["text"].startswith("#"):
            blocks.append((start, index + 1))
            start = index + 1
    if start < len(atoms):
        if blocks:
            blocks[-1] = (blocks[-1][0], len(atoms))
        elif len(atoms) > 1:
            blocks.append((0, len(atoms)))
        else:
            errors.append(f"record {unit!r}: a lone heading cannot form a mechanical passage")
            return []

    cards = []
    first = 0
    raw_length = 0
    for start, end in blocks:
        block = "".join(atom["text"] + atom["sep"] for atom in atoms[start:end])
        opens_heading = atoms[start]["text"].startswith("#")
        if first < start and (opens_heading or raw_length + len(block.rstrip()) > limit):
            cards.append({"from": first + 1, "to": start})
            first, raw_length = start, 0
        raw_length += len(block)
    cards.append({"from": first + 1, "to": len(atoms)})
    return cards


def card_alias(card, fields):
    lines = []
    for field in fields:
        value = card[field]
        lines.extend(value if isinstance(value, list) else [value])
    return "\n".join(lines)


def build_rows(titles, states, atoms, cards, alias_fields, mechanical):
    rows = []
    by_atom = {}
    for unit, title in titles.items():
        counters = Counter()
        state, = states[unit]
        for ordinal, card in enumerate(cards[unit], 1):
            first, last = card["from"], card["to"]
            passage = atoms[unit][first - 1:last]
            section = passage[0]["section_path"]
            slug = section_slug(section)
            counters[slug] += 1
            chunk_id = f"{unit}:{slug}:{counters[slug]:03d}"
            content = verbatim(passage)
            search_text, tokens, digest = search_fields(content, title, section)
            alias = None if mechanical else card_alias(card, alias_fields)
            rows.append((chunk_id, unit, section, ordinal, content, search_text,
                         alias, tokens, digest, 0, state))
            for number in range(first, last + 1):
                by_atom[unit, number] = chunk_id
    return rows, by_atom


def write_links(db, links, by_atom):
    db.execute("""
        CREATE TABLE passage_links (
            type TEXT, subject TEXT, reason TEXT, question TEXT,
            a_unit_id TEXT, a_chunk_id TEXT, a_says TEXT,
            b_unit_id TEXT, b_chunk_id TEXT, b_says TEXT
        )
    """)
    for link in links:
        values = [link[key] for key in ("type", "subject", "reason", "question")]
        for side in (link["a"], link["b"]):
            unit = side["unit_id"]
            values.extend((unit, by_atom[unit, side["from"]], side["says"]))
        db.execute("INSERT INTO passage_links VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", values)


def verify_alias_index(db):
    # Tokenize cards with SQLite itself, using the same default unicode61 tokenizer.
    # Probe one actual indexed term per card, including cards with non-Latin text.
    db.execute("CREATE VIRTUAL TABLE temp.kb_aliases USING fts5(alias)")
    db.execute("""
        INSERT INTO temp.kb_aliases(rowid, alias)
        SELECT rowid, search_alias FROM chunks WHERE search_alias IS NOT NULL
    """)
    db.execute("CREATE VIRTUAL TABLE temp.kb_alias_words USING fts5vocab(kb_aliases, instance)")
    probes = db.execute("SELECT doc, min(term) FROM temp.kb_alias_words GROUP BY doc").fetchall()
    for rowid, term in probes:
        query = '"' + term.replace('"', '""') + '"'
        hit = db.execute(
            "SELECT 1 FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid = ?", (query, rowid)
        ).fetchone()
        if hit is None:
            raise ValueError(f"FTS card lookup did not find passage at rowid {rowid}")


def replace_chunks(database, rows, links, by_atom, mechanical):
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("BEGIN")
        db.execute("DELETE FROM chunks")
        db.executemany("""
            INSERT INTO chunks (chunk_id, unit_id, section_path, ord, content, search_text,
                                search_alias, token_count, content_sha256, overlap_prev, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, rows)
        if links is not None:
            write_links(db, links, by_atom)
        db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
        db.execute("INSERT INTO chunks_fts(chunks_fts, rank) VALUES ('integrity-check', 1)")
        if not mechanical:
            verify_alias_index(db)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", type=Path)
    parser.add_argument("atoms", type=Path)
    parser.add_argument("dst", type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--markup", type=Path, nargs="+")
    mode.add_argument("--mechanical", type=int, metavar="N")
    parser.add_argument("--links", type=Path)
    parser.add_argument("--alias", default=",".join(ALIAS_FIELDS))
    args = parser.parse_args()

    source, destination = args.src.resolve(), args.dst.absolute()
    errors, hashes = [], {}
    if destination.exists() or destination.is_symlink():
        errors.append(f"destination already exists: {destination}")
    if source in destination.resolve().parents:
        errors.append("destination cannot be inside the source package")
    mechanical = args.mechanical is not None
    if mechanical and args.mechanical < 1:
        errors.append("--mechanical must be a positive character limit")
    alias_fields = args.alias.split(",")
    if set(alias_fields) - set(ALIAS_FIELDS) or len(alias_fields) != len(set(alias_fields)):
        errors.append("--alias must list distinct fields from title,gist,questions,phrasings")

    try:
        titles, chunks, states = load_source(source / "ai.db", hashes)
    except (OSError, sqlite3.Error) as exc:
        errors.append(f"cannot read source package: {exc}")
        titles, chunks, states = {}, {}, {}
    if not titles:
        errors.append("source package has no records")
    for unit in titles:
        if len(states.get(unit, ())) != 1:
            errors.append(f"source record {unit!r} must have exactly one chunk state")

    atoms = load_atoms(args.atoms, titles, chunks, hashes, errors)
    if mechanical:
        cards = {unit: mechanical_cards(unit, record, args.mechanical, errors)
                 for unit, record in atoms.items()}
    else:
        cards = load_markup(args.markup, atoms, hashes, errors)
    links = load_links(args.links, atoms, hashes, errors) if args.links else None
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 2

    rows, by_atom = build_rows(titles, states, atoms, cards, alias_fields, mechanical)
    sizes = [len(row[4]) for row in rows]
    metadata = {
        "source": str(source),
        "input_sha256": hashes,
        "mode": "mechanical" if mechanical else "markup",
        "counts": {"source_chunks": len(chunks), "atoms": len(by_atom),
                   "passages": len(rows), "records": len(titles), "links": len(links or [])},
        "passage_size_chars": {"min": min(sizes), "median": median(sizes), "max": max(sizes)},
        "records": {unit: len(cards[unit]) for unit in titles},
        "links_per_type": dict(Counter(link["type"] for link in links or [])),
        "note": "Package manifests still describe the source package.",
    }
    if mechanical:
        metadata["mechanical_limit"] = args.mechanical
        metadata["passages_over_limit"] = sum(size > args.mechanical for size in sizes)
    else:
        metadata["alias_fields"] = alias_fields
    rendered = json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True)

    created = complete = False
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.mkdir()
        created = True
        shutil.copytree(source, destination, dirs_exist_ok=True)
        replace_chunks(destination / "ai.db", rows, links, by_atom, mechanical)
        (destination / "kb-passages-applied.json").write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        complete = True
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"build failed: {exc}", file=sys.stderr)
        return 2
    finally:
        if created and not complete:
            try:
                shutil.rmtree(destination)
            except OSError as cleanup_error:
                print(f"cannot remove failed destination: {cleanup_error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
