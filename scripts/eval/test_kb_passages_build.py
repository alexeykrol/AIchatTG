"""CLI tests using the source package's SQLite schema."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


TOOL = Path(__file__).with_name("kb_passages_build.py")
SCHEMA = """
CREATE TABLE units (
    unit_id        TEXT PRIMARY KEY,
    unit_type      TEXT NOT NULL CHECK (unit_type IN ('course','lesson','topic','quiz')),
    course_id      INTEGER NOT NULL,          -- прод-ID курса-контейнера
    parent_id      TEXT,                      -- unit_id родителя; NULL только у course
    order_path     TEXT NOT NULL,             -- JSON-массив позиций: [] | [4] | [4,2]
    title          TEXT NOT NULL,
    lang           TEXT NOT NULL DEFAULT 'ru',
    source_path    TEXT NOT NULL,             -- путь файла зеркала (относительный от корня репо)
    source_sha256  TEXT NOT NULL,             -- sha256 байтов файла зеркала
    prod_post_id   INTEGER,                   -- NULL, если из имени/шапки не извлёкся
    canonical_url  TEXT,                      -- только подтверждённый; «канон не угадывается» (§5)
    url_state      TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (url_state IN ('confirmed','unknown')),
    synced_at      TEXT,                      -- ISO; момент синка зеркала с прода
    mirror_git_sha TEXT,                      -- git rev-parse HEAD:courses/<папка>
    state          TEXT NOT NULL DEFAULT 'canonical'
                   CHECK (state IN ('canonical','superseded','blocked'))
);
CREATE TABLE chunks (
    chunk_id       TEXT PRIMARY KEY,
    unit_id        TEXT NOT NULL,
    section_path   TEXT,                      -- 'H1 > H2 > H3'; '' у преамбулы/корня
    ord            INTEGER NOT NULL,          -- порядок чанка в юните (1-based)
    content        TEXT NOT NULL,
    search_text    TEXT NOT NULL,             -- content + титул юнита + section_path (§6)
    search_alias   TEXT,                      -- дельта обогащения (см. выше)
    token_count    INTEGER,                   -- приближение: слова × 1.6 (см. chunker.py)
    content_sha256 TEXT,
    overlap_prev   INTEGER DEFAULT 0,
    state          TEXT DEFAULT 'canonical'   -- наследует state юнита
);
CREATE VIEW chunks_fts_src AS
    SELECT rowid AS rowid,
           chunk_id AS chunk_id,
           CASE WHEN search_alias IS NULL OR search_alias = ''
                THEN search_text
                ELSE search_text || char(10) || search_alias
           END AS search_text
    FROM chunks;
CREATE VIRTUAL TABLE chunks_fts USING fts5(
    chunk_id UNINDEXED,
    search_text,
    content=chunks_fts_src,
    content_rowid=rowid
);
"""


class BuildPassagesTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(dir=TOOL.resolve().parents[2])
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.src, self.dst = self.root / "source", self.root / "result"
        self.src.mkdir()
        self.atoms_path = self.root / "atoms.jsonl"
        self.markup_path = self.root / "passages.jsonl"
        self.links_path = self.root / "links.jsonl"
        with closing(sqlite3.connect(self.src / "ai.db")) as db, db:
            db.executescript(SCHEMA)
            db.execute("CREATE TABLE preserved (label TEXT)")
            db.execute("INSERT INTO preserved VALUES ('kept')")
            for unit, state in (("record-a", "canonical"), ("record-b", "superseded")):
                title = f"Title for {unit}"
                db.execute("""
                    INSERT INTO units (unit_id, unit_type, course_id, order_path, title,
                                       source_path, source_sha256, state)
                    VALUES (?, 'lesson', 1, '[]', ?, 'fixture.md', 'fixture', ?)
                """, (unit, title, state))
                content = "Source body."
                db.execute("""
                    INSERT INTO chunks VALUES (?, ?, ?, 1, ?, ?, NULL, 3, ?, 0, ?)
                """, (f"{unit}:heading:001", unit, "Heading", content,
                      f"{content}\n{title} > Heading", hashlib.sha256(content.encode()).hexdigest(),
                      state))
            db.execute("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
        (self.src / "package-manifest.json").write_text('{"description":"source"}', encoding="utf-8")
        self.source_bytes = (self.src / "ai.db").read_bytes()

        self.atoms = []
        for unit, texts in (
            ("record-a", ["Lead.", "# Head", "Body text.", "Another line.", "Final."]),
            ("record-b", ["Other.", "Text."]),
        ):
            for number, text in enumerate(texts, 1):
                self.atoms.append({"unit_id": unit, "n": number, "text": text,
                                   "sep": "\n\n" if number == 2 else "\n",
                                   "chunk_id": f"{unit}:heading:001", "section_path": "Heading"})
        self.write_rows(self.atoms_path, self.atoms)
        self.cards = [self.card("record-a", 1, 2), self.card("record-a", 3, 5),
                      self.card("record-b", 1, 2)]
        self.write_rows(self.markup_path, self.cards)

    @staticmethod
    def card(unit, first, last):
        return {"unit_id": unit, "from": first, "to": last, "title": "ultramarine",
                "gist": "Abstract", "questions": ["Which hue?", "What colour?"],
                "phrasings": ["blue pigment"], "concepts": ["colour"]}

    @staticmethod
    def write_rows(path, rows):
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def run_cli(self, *options, status=0):
        result = subprocess.run(
            [sys.executable, str(TOOL), str(self.src), str(self.atoms_path), str(self.dst),
             *map(str, options)], capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, status, result.stderr)
        self.assertEqual((self.src / "ai.db").read_bytes(), self.source_bytes)
        return result

    def test_markup_end_to_end(self):
        self.cards[1]["title"] = "cerulean"
        second_markup = self.root / "second.jsonl"
        self.write_rows(self.markup_path, self.cards[:2])
        self.write_rows(second_markup, self.cards[2:])
        result = self.run_cli("--markup", self.markup_path, second_markup)
        info = json.loads(result.stdout)
        self.assertEqual(info, json.loads((self.dst / "kb-passages-applied.json").read_text()))
        self.assertEqual(info["counts"], {"atoms": 7, "records": 2, "passages": 3,
                                          "links": 0, "source_chunks": 2})
        for path in (self.atoms_path, self.markup_path, second_markup, self.src / "ai.db"):
            self.assertEqual(info["input_sha256"][str(path.resolve())],
                             hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual((self.dst / "package-manifest.json").read_bytes(),
                         (self.src / "package-manifest.json").read_bytes())
        with closing(sqlite3.connect(self.dst / "ai.db")) as db:
            rows = db.execute("SELECT * FROM chunks ORDER BY unit_id, ord").fetchall()
            self.assertEqual(rows[0][:7], (
                "record-a:heading:001", "record-a", "Heading", 1, "Lead.\n# Head",
                "Lead.\n# Head\nTitle for record-a > Heading",
                "ultramarine\nAbstract\nWhich hue?\nWhat colour?\nblue pigment",
            ))
            self.assertEqual(rows[0][7:], (
                3, hashlib.sha256(b"Lead.\n# Head").hexdigest(), 0, "canonical",
            ))
            self.assertEqual(rows[1][4], "Body text.\nAnother line.\nFinal.")
            self.assertEqual(rows[2][-1], "superseded")
            self.assertEqual(db.execute(
                "SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH 'cerulean'"
            ).fetchall(), [("record-a:heading:002",)])
            self.assertEqual(db.execute("SELECT label FROM preserved").fetchall(), [("kept",)])

    def test_alias_fields_and_link_starts(self):
        self.write_rows(self.links_path, [{
            "type": "qualifies", "subject": "hue", "reason": "shade", "question": "Which?",
            "a": {"unit_id": "record-a", "from": 2, "to": 4, "says": "first"},
            "b": {"unit_id": "record-a", "from": 3, "to": 5, "says": "second"},
        }])
        result = self.run_cli("--markup", self.markup_path, "--alias", "phrasings,gist",
                              "--links", self.links_path)
        self.assertEqual(json.loads(result.stdout)["links_per_type"], {"qualifies": 1})
        with closing(sqlite3.connect(self.dst / "ai.db")) as db:
            self.assertEqual(db.execute("SELECT DISTINCT search_alias FROM chunks").fetchall(),
                             [("blue pigment\nAbstract",)])
            self.assertEqual(db.execute("SELECT * FROM passage_links").fetchall(), [
                ("qualifies", "hue", "shade", "Which?", "record-a", "record-a:heading:001",
                 "first", "record-a", "record-a:heading:002", "second"),
            ])

    def test_markup_validation_aggregates_errors(self):
        duplicate = self.root / "duplicate.jsonl"
        self.write_rows(duplicate, [self.cards[0]])
        cases = (
            (self.cards[1:], (), "expected range to start at 1"),
            ([self.cards[0], self.cards[2]], (), "expected coverage through atom 5"),
            ([self.cards[1], self.cards[0], self.cards[2]], (), "expected range to start at 6"),
            ([self.cards[0], self.card("record-a", 2, 5), self.cards[2]], (), "start at 3"),
            ([self.card("record-a", 0, 5), self.cards[2]], (), "outside record"),
            ([self.card("record-a", 1, 6), self.cards[2]], (), "outside record"),
            ([self.card("record-a", 3, 1), self.cards[2]], (), "outside record"),
            (self.cards + [self.card("unknown", 1, 1)], (), "unknown record"),
            ([{**self.cards[0], "from": True, "title": None, "concepts": [7]}],
             (), "from must be int"),
            (self.cards, (duplicate,), "appears in multiple markup files"),
        )
        for rows, more, diagnostic in cases:
            with self.subTest(diagnostic=diagnostic, rows=rows):
                self.write_rows(self.markup_path, rows)
                result = self.run_cli("--markup", self.markup_path, *more, status=2)
                self.assertIn(diagnostic, result.stderr)
                if diagnostic == "from must be int":
                    self.assertIn("title must be str", result.stderr)
                    self.assertIn("concepts must contain only strings", result.stderr)
                self.assertFalse(self.dst.exists())

    def test_invalid_atoms_links_and_alias_leave_no_destination(self):
        atom = {**self.atoms[0], "n": 2}
        self.write_rows(self.atoms_path, [atom, *self.atoms[1:]])
        self.write_rows(self.links_path, [{
            "type": "invented", "subject": "hue", "reason": "shade", "question": "Which?",
            "a": {"unit_id": "record-a", "from": 2, "to": 10, "says": "first"},
            "b": {"unit_id": "unknown", "from": 1, "to": 2, "says": "second"},
        }])
        result = self.run_cli("--markup", self.markup_path, "--links", self.links_path,
                              "--alias", "concepts", status=2)
        for diagnostic in ("--alias", "expected atom 1", "unknown link type",
                           "outside record", "unknown record"):
            self.assertIn(diagnostic, result.stderr)
        self.assertFalse(self.dst.exists())

    def test_mechanical_respects_limit_and_opens_at_heading(self):
        self.run_cli("--mechanical", 20)
        with closing(sqlite3.connect(self.dst / "ai.db")) as db:
            self.assertEqual(db.execute("""
                SELECT content, search_alias, overlap_prev FROM chunks
                WHERE unit_id = 'record-a' ORDER BY ord
            """).fetchall(), [("Lead.", None, 0), ("# Head\n\nBody text.", None, 0),
                               ("Another line.\nFinal.", None, 0)])

    def test_mechanical_keeps_consecutive_and_terminal_headings_with_body(self):
        texts = ["Intro", "# One", "## Two", "Body", "# End"]
        atoms = [{**atom, "text": text} for atom, text in zip(self.atoms[:5], texts)]
        self.write_rows(self.atoms_path, atoms + self.atoms[5:])
        self.run_cli("--mechanical", 50)
        with closing(sqlite3.connect(self.dst / "ai.db")) as db:
            self.assertEqual(db.execute("""
                SELECT content FROM chunks WHERE unit_id = 'record-a' ORDER BY ord
            """).fetchall(), [("Intro",), ("# One\n\n## Two\nBody\n# End",)])

    def test_existing_destination_is_preserved(self):
        self.dst.mkdir()
        sentinel = self.dst / "sentinel"
        sentinel.write_text("keep", encoding="utf-8")
        result = self.run_cli("--mechanical", 20, status=2)
        self.assertIn("destination already exists", result.stderr)
        self.assertEqual(list(self.dst.iterdir()), [sentinel])
        self.assertEqual(sentinel.read_text(), "keep")

    def test_copy_is_removed_when_transaction_fails(self):
        with closing(sqlite3.connect(self.src / "ai.db")) as db, db:
            db.execute("DROP TABLE chunks_fts")
        self.source_bytes = (self.src / "ai.db").read_bytes()
        result = self.run_cli("--mechanical", 20, status=2)
        self.assertIn("no such table: chunks_fts", result.stderr)
        self.assertFalse(self.dst.exists())


if __name__ == "__main__":
    unittest.main()
