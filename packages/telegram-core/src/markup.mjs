/**
 * Разметка ответа для Telegram: Markdown модели → HTML Telegram, плюс честный
 * плоский текст на случай отказа и нарезка по лимиту сообщения.
 *
 * WHY этот модуль вообще существует. Модель отвечает markdown'ом — так она
 * пишет по умолчанию, и на боевых ответах это видно, — а адаптер отправлял
 * текст без `parse_mode`, и живой пользователь читал `**жирный**` и `###`
 * буквально. Дефект видел каждый, кто задал вопрос в день выката.
 *
 * WHY HTML, а не MarkdownV2: Telegram не знает заголовков ни в одном режиме, а
 * MarkdownV2 требует экранировать полтора десятка знаков в ОБЫЧНОМ тексте —
 * любая забытая точка или дефис роняет всё сообщение. HTML же требует ровно три
 * замены (`&`, `<`, `>`), после которых текст безопасен по построению: класс
 * ошибки «сообщение не ушло из-за случайного знака» становится недостижимым, а
 * не маловероятным.
 *
 * Ноль сети и ноль состояния: чистые функции, проверяемые офлайн. Транспорт,
 * фолбэк и повтор живут в адаптере рантайма.
 */

// Telegram режет сообщение на 4096 символах. Берём запас: HTML-теги в счёт
// длины не входят, но эмодзи и суррогатные пары считаются по-разному в разных
// местах API, и упереться в границу ровно — значит однажды получить 400.
export const TELEGRAM_MESSAGE_LIMIT = 3800;

// Разрешённые схемы ссылок. Всё остальное отдаётся текстом: `javascript:` в
// ответе бота не должно существовать даже теоретически.
const SAFE_LINK = /^https?:\/\//i;

// Метка вынутого блока кода. Символ приватной области Unicode: в осмысленном
// тексте он не встречается, а на входе ещё и вырезается (`stripMarks`) —
// поэтому подделать метку содержимым ответа структурно невозможно, а не
// маловероятно. Пробелы как разделитель метки не годятся: `trim()` их съедает,
// и заполнитель остался бы в тексте буквально.
const MARK = '\uE000';
const FENCE_MARK = /\uE000F(\d+)\uE000/g;
const CODE_MARK = /\uE000C(\d+)\uE000/g;

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Плоский текст: те же строки, но без знаков разметки. Используется фолбэком,
 * когда Telegram отверг HTML, — читателю достаётся ответ без оформления, а не
 * молчание. Ссылка `[текст](url)` разворачивается в «текст: url», иначе адрес
 * пропал бы вместе с разметкой.
 */
export function plainTextFromMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue; // горизонтальная линейка
    let text = line.replace(/^\s{0,3}(#{1,6})\s+/, '').replace(/^(\s*)[-*]\s+/, '$1• ');
    text = text
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, '$1$2')
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1$2')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
    out.push(text.replace(/\s+$/, ''));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Markdown модели → HTML Telegram.
 *
 * Порядок обработки — контракт, а не вкус: сначала из текста вынимаются блоки
 * кода (внутри них разметка не действует), затем экранируются `&<>`, и только
 * потом появляются собственные теги. Обратный порядок означал бы экранирование
 * уже вставленных тегов.
 *
 * Заголовки Telegram не поддерживает вовсе, поэтому `### Заголовок` становится
 * жирной строкой: это единственная форма, доступная в его наборе тегов.
 */
export function telegramHtmlFromMarkdown(markdown) {
  const source = stripMarks(markdown).replace(/\r\n?/g, '\n');
  const fences = [];
  // Блок кода вынимается ПЕРВЫМ и возвращается последним: внутри него `**` и `_`
  // — обычные символы, и обработать их как разметку значило бы испортить код.
  const withoutFences = source.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    fences.push(code.replace(/\n$/, ''));
    return `${MARK}F${fences.length - 1}${MARK}`;
  });

  const codes = [];
  const withoutCode = withoutFences.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return `${MARK}C${codes.length - 1}${MARK}`;
  });

  const lines = escapeHtml(withoutCode).split('\n');
  const rendered = lines.map((line) => {
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) return '';
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) return `<b>${inline(heading[2]).trim()}</b>`;
    // Списков у Telegram нет ни в одном режиме, поэтому маркер приходится
    // рисовать самим: `• ` читается как список, а голый дефис — как дефис.
    // Хвостовые пробелы (markdown-перенос строки) в HTML ничего не значат и
    // оставляют видимый мусор.
    return inline(line.replace(/^(\s*)[-*]\s+/, '$1• ')).replace(/\s+$/, '');
  });

  return rendered.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    .replace(CODE_MARK, (_, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`)
    .replace(FENCE_MARK, (_, index) => `<pre>${escapeHtml(fences[Number(index)])}</pre>`);
}

function stripMarks(text) {
  return String(text ?? '').replaceAll(MARK, '');
}

/**
 * Внутристрочная разметка одной уже экранированной строки. Курсив требует
 * границы слова: `__init__` и `snake_case` внутри слова курсивом не являются,
 * и без этого условия обычный текст с подчёркиваниями рвал бы теги.
 */
function inline(line) {
  return line
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (match, text, url) => (
      SAFE_LINK.test(url) ? `<a href="${url.replaceAll('"', '&quot;')}">${text}</a>` : `${text}: ${url}`
    ))
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1<i>$2</i>');
}

/**
 * Нарезка длинного ответа на сообщения. Telegram отвергает всё длиннее лимита
 * целиком — то есть длинный ответ сегодня не «обрезается», а НЕ ДОХОДИТ вовсе.
 * Потолок ответа модели (2048 токенов) по-русски даёт до ~6 000 знаков, так что
 * это не гипотетический случай.
 *
 * Режем по убыванию приоритета границы: пустая строка → перевод строки →
 * пробел → жёстко по длине. Теги не разрываются: рез идёт по исходному markdown
 * ДО рендера, поэтому открытый `<b>` не может остаться без пары.
 */
export function splitForTelegram(markdown, { limit = TELEGRAM_MESSAGE_LIMIT } = {}) {
  const text = String(markdown ?? '');
  if (text.length <= limit) return text.trim() ? [text] : [];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    const at = cut > limit * 0.5 ? cut : limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).replace(/^\s+/, '');
  }
  if (rest.trim()) parts.push(rest.trim());
  return parts.filter(Boolean);
}

/**
 * Отказ Telegram именно по разбору разметки — единственный случай, когда
 * повторная отправка законна. Сообщение при таком отказе НЕ доставлено (400 до
 * доставки), поэтому плоский повтор не может задвоить ответ. Любая другая
 * ошибка (лимиты, права, сеть) повтору не подлежит: она либо не лечится
 * снятием разметки, либо неоднозначна по факту доставки.
 */
export function isMarkupParseError(error) {
  const text = String(error ?? '').toLowerCase();
  return text.includes("can't parse entities")
    || text.includes('can’t parse entities')
    || text.includes('cant parse entities')
    || text.includes('unsupported start tag')
    || text.includes('unclosed start tag');
}
