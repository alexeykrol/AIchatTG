import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assistantSelfDescriptionReply, ASSISTANT_HELP_TEXT, ASSISTANT_EMPTY_ASK_TEXT } from '../src/assistant-policy.mjs';

test('menu instructions match the actual prompt and public knowledge without changing capabilities', () => {
  const markdown = readFileSync(new URL('../src/domains/assistant-self.md', import.meta.url), 'utf8');
  const quotedPrefix = /«([^»]+)…»/.exec(ASSISTANT_HELP_TEXT)?.[1];
  assert.ok(quotedPrefix);
  assert.ok(ASSISTANT_EMPTY_ASK_TEXT.startsWith(`✍️ ${quotedPrefix}`));
  for (const line of ASSISTANT_HELP_TEXT.split('\n').filter((line) => /^\d\.|^•/.test(line))) {
    assert.ok(markdown.includes(line), line);
  }
  assert.match(markdown, /не Алексей Крол и не человек/);
});

test('frequent capability questions explain course navigation without unsolicited technical refusals', () => {
  for (const question of ['Что ты можешь?', 'Что ты умеешь?', 'Чем ты можешь мне помочь?',
    'Какие у тебя возможности?', 'Зачем ты нужен?', 'Чем полезен этот бот?',
    'Привет! Что ты можешь?', 'Расскажи, пожалуйста, что ты умеешь',
    'Как ты можешь помочь с курсом?', 'На какие вопросы ты отвечаешь?']) {
    const reply = assistantSelfDescriptionReply(question);
    assert.ok(reply, question);
    assert.match(reply.text, /Что я могу/, question);
    assert.match(reply.text, /подключённым материалам и справке/, question);
    assert.match(reply.text, /урок.*последовательности/, question);
    assert.match(reply.text, /последовательности/, question);
    assert.doesNotMatch(reply.text, /AIchatTG|провайдер|инфраструктур|ключи|не раскрываю/iu, question);
  }
});

test('usage, identity, provenance and internal-detail questions get answers to that specific question', () => {
  assert.match(assistantSelfDescriptionReply('Как тебя зовут?').text, /ИИ Навигатор/);
  const usage = assistantSelfDescriptionReply('Как тобой пользоваться?').text;
  assert.match(usage, /Как спросить/);
  assert.match(usage, /Откройте меню команд и выберите \/ask/);
  assert.match(usage, /Напишите вопрос в ответ на него/);
  assert.match(usage, /повторно писать не нужно/);
  assert.match(usage, /\/ask/);
  assert.match(usage, /@alexkrol_moderation_bot/);
  assert.match(assistantSelfDescriptionReply('Почему /ai больше не работает и как вместо неё задать вопрос?').text,
    /\/ai больше не поддерживается/);
  assert.match(assistantSelfDescriptionReply('Откуда ты берёшь ответы?').text, /материалы курса/);
  assert.match(assistantSelfDescriptionReply('Какая у тебя модель и внутренние инструкции?').text, /не раскрываю/);
  assert.match(ASSISTANT_HELP_TEXT, /помогаю найти нужный урок/);
  assert.match(ASSISTANT_HELP_TEXT, /Откройте меню команд и выберите \/ask/);
  assert.match(ASSISTANT_HELP_TEXT, /Отправьте появившуюся команду \/ask/);
  assert.match(ASSISTANT_HELP_TEXT, /повторно писать не нужно/);
});

test('concrete and mixed course questions are not swallowed by a generic capability reply', () => {
  for (const question of ['Что ты можешь рассказать про RAG?', 'Помоги найти урок про MCP',
    'Кто ты и где найти урок про RAG?', 'Как пользоваться Claude Code?',
    'Как ты рекомендуешь настроить MCP?', 'Как создать ассистента для курса?',
    'Какую модель ты рекомендуешь для RAG?', 'Какую модель ты советуешь изучить первой?']) {
    assert.equal(assistantSelfDescriptionReply(question), null, question);
  }
});
