import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TELEGRAM_MESSAGE_LIMIT,
  isMarkupParseError,
  plainTextFromMarkdown,
  splitForTelegram,
  telegramHtmlFromMarkdown,
} from '../src/markup.mjs';

test('markdown structure of a model answer becomes Telegram HTML', () => {
  const html = telegramHtmlFromMarkdown([
    '### Короткий ответ',
    '',
    'Главное: **действие важнее знания**, а _контекст_ решает.',
  ].join('\n'));

  assert.equal(html, [
    '<b>Короткий ответ</b>',
    '',
    'Главное: <b>действие важнее знания</b>, а <i>контекст</i> решает.',
  ].join('\n'));
});

test('the three HTML-significant characters are escaped before any tag is produced', () => {
  const html = telegramHtmlFromMarkdown('Сравните a < b && b > c в **<script>**');
  assert.equal(html, 'Сравните a &lt; b &amp;&amp; b &gt; c в <b>&lt;script&gt;</b>');
  assert.ok(!html.includes('<script>'));
});

test('an underscore inside a word is not italics, so identifiers survive intact', () => {
  const html = telegramHtmlFromMarkdown('переменная snake_case_name и путь a_b_c.');
  assert.equal(html, 'переменная snake_case_name и путь a_b_c.');
});

/**
 * Теги рождаются только парами, поэтому одинокий знак разметки в обычном тексте
 * не может открыть тег, который некому закрыть, — а именно на незакрытом теге
 * Telegram отвергает сообщение целиком.
 */
test('a lone marker cannot open a tag that is never closed', () => {
  assert.equal(telegramHtmlFromMarkdown('вес 5 * 3 и ставка _ниже'), 'вес 5 * 3 и ставка _ниже');
  assert.equal(telegramHtmlFromMarkdown('**незакрытое выделение'), '**незакрытое выделение');
});

test('http links become anchors and any other scheme is degraded to visible text', () => {
  assert.equal(
    telegramHtmlFromMarkdown('[Урок 9](https://alexeykrol.com/courses/ai_full/lessons/9/)'),
    '<a href="https://alexeykrol.com/courses/ai_full/lessons/9/">Урок 9</a>',
  );
  assert.equal(
    telegramHtmlFromMarkdown('[клик](javascript:alert(1))'),
    'клик: javascript:alert(1)',
  );
});

test('code stays code: fences and inline spans are not touched by inline markup', () => {
  const html = telegramHtmlFromMarkdown([
    'Вызов `__init__` и блок:',
    '',
    '```python',
    'def f(a, b):',
    '    return a ** b < a',
    '```',
  ].join('\n'));

  assert.ok(html.includes('<code>__init__</code>'), html);
  assert.ok(html.includes('<pre>def f(a, b):\n    return a ** b &lt; a</pre>'), html);
  assert.ok(!html.includes('<b>'), html);
});

/**
 * Метка-заполнитель вырезается на входе, поэтому текст ответа не может выдать
 * себя за вынутый блок кода: класс подмены недостижим, а не маловероятен.
 */
test('a forged placeholder in the source text cannot resurrect a code block', () => {
  const html = telegramHtmlFromMarkdown('обычный текст \uE000F0\uE000 без кода');
  assert.equal(html, 'обычный текст F0 без кода');
});

test('horizontal rules disappear instead of turning into stray dashes', () => {
  assert.equal(telegramHtmlFromMarkdown('до\n\n---\n\nпосле'), 'до\n\nпосле');
});

test('list markers become bullets and markdown trailing spaces leave no visible residue', () => {
  assert.equal(
    telegramHtmlFromMarkdown('Итого:  \n- первый\n* второй\n  - вложенный'),
    'Итого:\n• первый\n• второй\n  • вложенный',
  );
  assert.equal(
    plainTextFromMarkdown('- **первый**  \n- второй'),
    '• первый\n• второй',
  );
});

test('the plain-text fallback keeps every word and unfolds links', () => {
  const plain = plainTextFromMarkdown([
    '### Заголовок',
    'Текст с **выделением** и [ссылкой](https://example.test/a).',
    '`код` тоже читается.',
  ].join('\n'));

  assert.equal(plain, [
    'Заголовок',
    'Текст с выделением и ссылкой: https://example.test/a.',
    'код тоже читается.',
  ].join('\n'));
});

test('a short answer is one part and an empty one is no part at all', () => {
  assert.deepEqual(splitForTelegram('короткий ответ'), ['короткий ответ']);
  assert.deepEqual(splitForTelegram('   \n  '), []);
  assert.deepEqual(splitForTelegram(''), []);
});

test('a long answer is split on paragraph boundaries and loses no text', () => {
  const paragraph = 'абзац '.repeat(40).trim();
  const source = Array.from({ length: 24 }, (_, index) => `${index}: ${paragraph}`).join('\n\n');
  assert.ok(source.length > TELEGRAM_MESSAGE_LIMIT);

  const parts = splitForTelegram(source);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= TELEGRAM_MESSAGE_LIMIT, `part ${part.length}`);
  assert.equal(
    parts.join(' ').replace(/\s+/g, ' '),
    source.replace(/\s+/g, ' '),
  );
});

test('text without any break is still cut at the hard limit rather than dropped', () => {
  const parts = splitForTelegram('x'.repeat(TELEGRAM_MESSAGE_LIMIT * 2 + 7));
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map((part) => part.length), [TELEGRAM_MESSAGE_LIMIT, TELEGRAM_MESSAGE_LIMIT, 7]);
});

test('only a markup parse refusal is recognised as resendable', () => {
  assert.equal(isMarkupParseError("Bad Request: can't parse entities: Unsupported start tag \"b\" at byte offset 12"), true);
  assert.equal(isMarkupParseError('Bad Request: can’t parse entities'), true);
  assert.equal(isMarkupParseError('Bad Request: unclosed start tag at byte offset 4'), true);
  assert.equal(isMarkupParseError('Too Many Requests: retry after 30'), false);
  assert.equal(isMarkupParseError('Forbidden: bot was blocked by the user'), false);
  assert.equal(isMarkupParseError('http_500'), false);
  assert.equal(isMarkupParseError(undefined), false);
});
