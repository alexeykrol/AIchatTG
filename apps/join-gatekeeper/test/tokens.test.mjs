import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import { JoinStore } from '../src/store.mjs';
import { runTokensCli } from '../src/tokens-cli.mjs';
import {
  generateToken, generateTokens, hashToken, isTokenFormat, OUTPUT_HEADER, parseIdsCsv, parseTokensCsv, reissueToken, tokenStatus,
} from '../src/tokens.mjs';
import { tempDir } from './helpers.mjs';

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const T = Date.parse('2026-11-17T10:00:00.000Z');
const BOT = 'join_test_bot';

let dir;
let store;
afterEach(() => {
  store?.close();
  store = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function setup() {
  dir = tempDir();
  store = new JoinStore(path.join(dir, 'join-gatekeeper.sqlite'));
  return { dir, store };
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

describe('token format', () => {
  test('32 chars base64url from 24 random bytes, unique', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const token = generateToken();
      assert.match(token, /^[A-Za-z0-9_-]{32}$/);
      assert.ok(isTokenFormat(token));
      seen.add(token);
    }
    assert.equal(seen.size, 200);
    assert.equal(hashToken('abc').length, 64);
    assert.ok(!isTokenFormat('gate'));
  });

  test('input CSV: exact header, valid unique ids', () => {
    assert.deepEqual(parseIdsCsv('site_record_id\nA1\nb_2-x\n'), ['A1', 'b_2-x']);
    assert.deepEqual(parseIdsCsv('site_record_id\r\nA1\r\n'), ['A1']);
    assert.throws(() => parseIdsCsv('id\nA1\n'), /header/);
    assert.throws(() => parseIdsCsv('site_record_id\nA 1\n'), /invalid/);
    assert.throws(() => parseIdsCsv('site_record_id\nx@y\n'), /invalid/);
    assert.throws(() => parseIdsCsv(`site_record_id\n${'a'.repeat(65)}\n`), /invalid/);
    assert.throws(() => parseIdsCsv('site_record_id\nA1\nA1\n'), /duplicate/);
    assert.throws(() => parseIdsCsv('site_record_id\n'), /no site_record_id/);
  });
});

describe('generate / reissue / status', () => {
  test('generate writes 0600 CSV with exact header and stores only hashes', () => {
    setup();
    const out = path.join(dir, 'tokens.csv');
    const result = generateTokens({ store, ids: ['s1', 's2'], outputPath: out, botUsername: BOT, now: T });
    assert.equal(result.count, 2);
    assert.equal(mode(out), 0o600);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.startsWith(`${OUTPUT_HEADER}\n`));
    assert.ok(!text.includes('\r'));
    const rows = parseTokensCsv(text);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(isTokenFormat(row.token));
      assert.equal(row.deepLink, `https://t.me/${BOT}?start=${row.token}`);
      const stored = store.getToken(hashToken(row.token));
      assert.equal(stored.status, 'issued');
      assert.equal(stored.site_record_id, row.siteRecordId);
    }
    const dbBytes = fs.readFileSync(path.join(dir, 'join-gatekeeper.sqlite')).toString('latin1')
      + (fs.existsSync(path.join(dir, 'join-gatekeeper.sqlite-wal'))
        ? fs.readFileSync(path.join(dir, 'join-gatekeeper.sqlite-wal')).toString('latin1') : '');
    for (const row of rows) assert.ok(!dbBytes.includes(row.token), 'plaintext token must not be stored');
  });

  test('refuses to overwrite, refuses without bot username, refuses an id with an active token', () => {
    setup();
    const out = path.join(dir, 'tokens.csv');
    fs.writeFileSync(out, 'existing');
    assert.throws(() => generateTokens({ store, ids: ['s1'], outputPath: out, botUsername: BOT, now: T }), /overwrite/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'existing');
    assert.equal(store.hasIssuedToken('s1'), false, 'no DB write when the file is refused');
    const out2 = path.join(dir, 'tokens2.csv');
    assert.throws(() => generateTokens({ store, ids: ['s1'], outputPath: out2, botUsername: '', now: T }), /bot-username/);
    assert.ok(!fs.existsSync(out2));
    generateTokens({ store, ids: ['s1'], outputPath: out2, botUsername: BOT, now: T });
    const out3 = path.join(dir, 'tokens3.csv');
    assert.throws(() => generateTokens({ store, ids: ['s2', 's1'], outputPath: out3, botUsername: BOT, now: T }), /active token/);
    assert.ok(!fs.existsSync(out3));
    assert.equal(store.hasIssuedToken('s2'), false, 'all-or-nothing');
    assert.throws(() => generateTokens({ store, ids: ['bad id'], outputPath: out3, botUsername: BOT, now: T }), /invalid/);
  });

  test('reissue revokes the old token, issues a new one; status never prints tokens', () => {
    setup();
    const first = path.join(dir, 'a.csv');
    generateTokens({ store, ids: ['s1'], outputPath: first, botUsername: BOT, now: T });
    const oldToken = parseTokensCsv(fs.readFileSync(first, 'utf8'))[0].token;
    const second = path.join(dir, 'b.csv');
    const result = reissueToken({ store, siteRecordId: 's1', outputPath: second, botUsername: BOT, now: T + 1 });
    assert.equal(result.revoked, 1);
    assert.equal(mode(second), 0o600);
    const newToken = parseTokensCsv(fs.readFileSync(second, 'utf8'))[0].token;
    assert.notEqual(newToken, oldToken);
    assert.equal(store.getToken(hashToken(oldToken)).status, 'revoked');
    assert.equal(store.getToken(hashToken(newToken)).status, 'issued');
    assert.throws(() => reissueToken({ store, siteRecordId: 'nope', outputPath: path.join(dir, 'c.csv'), botUsername: BOT }), /no tokens/);
    const status = tokenStatus({ store, siteRecordId: 's1' });
    assert.equal(status.active, true);
    assert.deepEqual(status.tokens.map((t) => t.status), ['revoked', 'issued']);
    const printed = JSON.stringify(status);
    assert.ok(!printed.includes(oldToken) && !printed.includes(newToken));
    assert.ok(!printed.includes(hashToken(newToken)));
  });

  test('CLI generate/status via DATA_ROOT only (no bot token / webhook secret needed)', () => {
    dir = tempDir();
    const input = path.join(dir, 'ids.csv');
    fs.writeFileSync(input, 'site_record_id\nr1\nr2\n');
    const out = path.join(dir, 'out.csv');
    const env = { JOIN_GATEKEEPER_DATA_ROOT: path.join(dir, 'data') };
    const printed = [];
    runTokensCli(['generate', '--input', input, '--output', out, '--bot-username', BOT], { env, out: (l) => printed.push(l) });
    assert.equal(JSON.parse(printed[0]).generated, 2);
    const stdout = execFileSync(process.execPath, ['src/tokens-cli.mjs', 'status', '--site-record-id', 'r1'], {
      cwd: APP_ROOT, encoding: 'utf8', env: { ...env, PATH: process.env.PATH },
    });
    const status = JSON.parse(stdout);
    assert.equal(status.active, true);
    const token = parseTokensCsv(fs.readFileSync(out, 'utf8'))[0].token;
    assert.ok(!stdout.includes(token));
  });
});
