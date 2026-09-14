---
title: Architecture
type: architecture
status: draft
updated: 2026-09-14
---

# Architecture

<!--
Этот файл — живая карта системы. Не история и не план, а ответ на вопрос
«где что лежит и как связано». Обновляй, когда меняется структура, а не
когда правишь конкретный файл.

Контракт-слой (что должно быть), а не state-слой (что есть прямо сейчас).
State живёт в SNAPSHOT.md, план — в BACKLOG.md, жёсткие запреты — в
INVARIANTS.md.
-->

## Карта системы

Node.js ESM-монорепозиторий (npm workspaces), три Telegram-бота как
адаптеры над одним рантаймом плюс операторская консоль:

- `apps/telegram-runtime/` — общий рантайм двух ролей: **Moderator** (модерация
  сообщений в чатах курса) и **Assistant** (ответы на вопросы студентов).
  Один код, две конфигурации бота, два токена, два webhook-маршрута.
- `apps/gatekeeper/` — третий бот: онбординг новых участников в чат
  (проверка доступа, приветствие, передача в Assistant).
- `apps/operator-console/` — веб-панель оператора: статус ботов, расход
  токенов, живые метрики. Не настройки ассистента без кода — тех пока нет
  (см. BACKLOG «простой веб-интерфейс для настроек»).
- `packages/telegram-core/` — общий код без побочных эффектов: разбор
  Telegram update (`classifyTelegramUpdate`), определение обращения к
  боту (`detectAssistantQuestion` — команда/упоминание/reply), рендер
  Markdown → Telegram HTML, доменные типы модерации и знания. Используется
  всеми тремя ботами.
- `infra/aichattg/` — `docker-compose.yml` (профили сервисов), Dockerfile
  на каждое приложение, `runtime.env.example`.
- `docs/` — эксплуатационная документация (не курс, не книга): раннбуки,
  спецификации включения знания, миграции, и `OWNER_FEEDBACK_LOG.md` —
  история личных репортов владельца отдельно от `CHANGELOG.md`.
- `.handoffs/` — исторические чартеры Codex-эпохи (до 2026-09-14),
  сохранены для provenance, не живой реестр.
- `scripts/aichattg/` — эксплуатационные скрипты (безопасное чтение
  Docker-логов, проверка чистоты релизного среза, telegram-ops CLI).

## Слои и границы

- `packages/telegram-core` не знает о `apps/*` и не имеет побочных
  эффектов (нет сети, нет БД) — чистые функции над Telegram-объектами.
  Импортируется как `@aichattg/telegram-core`.
- `apps/telegram-runtime/src/runtime.mjs` — точка сборки конвейера
  запроса: модерация → cooldown/дневной лимит → маршрутизация (анализатор
  или роутер-модель) → ретривал знания → вызов модели → рендер → отправка.
  Каждый шаг — отдельный модуль (`assistant-policy.mjs`,
  `assistant-dialogue.mjs`, `provider-adapter.mjs`, `knowledge-adapter.mjs`,
  `telegram-adapter.mjs`, `route-arbitration.mjs`, `analyzer-adapter.mjs`).
- `database.mjs` — SQLite (better-sqlite3), локально на VPS; таблицы для
  диалоговой памяти (ограниченной, TTL), модерационных страйков, дневных
  лимитов, чеков входящих апдейтов, журналов знания/дефицитов.
- Продакшн-runtime не имеет доступа к News Digest проекту — граница
  оформлена явно в `AGENTS.md` («Runtime boundary»): отдельные репозиторий,
  контейнер, БД, секреты, webhook-маршруты. Прямой доступ к чужой БД
  запрещён инвариантом.

## Ключевые контракты

- `detectAssistantQuestion(message, botUsername, botId)` — единственное
  место, решающее, обращаются ли к ассистенту: `/ask` (команда в любом
  месте текста), `@упоминание` (в любом месте текста), или **reply** на
  собственное сообщение бота (добавлено 2026-09-14, `f51753f`) — три
  формы, должны совпадать с текстом `/help` (`ASSISTANT_HELP_TEXT`).
- Telegram Privacy Mode: бот без элевации не получает вебхук на голое
  сообщение без команды/упоминания/reply — учитывай это при любом новом
  сценарии обращения к ассистенту.
- `assistantDeterministicReply`/`assistantSelfDescriptionReply` —
  код-owned детерминированные ответы (presence ping, самоописание,
  границы) в обход платной модели; `assistantSelfDescriptionReply`
  обязана вызываться независимо от `assistantKnowledgeEnabled` (баг
  2026-09-14, `2c02c56`: раньше не вызывалась при включённом знании).
- Знание курса — content-addressed пакет, верифицируется по манифесту,
  срезы `org`/`value`/`course-operations-v1`/`course-value-v1`/
  `course-content-v1`; отказ ретривала классифицируется явно (abstention
  vs routing-failure) — см. `assistant-policy.mjs`.
- Три статуса релизной готовности (`AGENTS.md`): `passed` / `failed` /
  `not_run` / `inconclusive` — используются при отчёте перед прод-деплоем.

## Точки входа и выходы

- Webhook `/webhooks/telegram/moderator` и `/webhooks/telegram/assistant`
  — отдельные секреты, отдельные боты, общий HTTP-сервер
  (`apps/telegram-runtime/src/http-server.mjs`).
- `npm run test:runtime` — юнит/интеграционные тесты
  telegram-runtime + telegram-core (Node `--test`, Node 20.20.x —
  `better-sqlite3` требует пересборки под точную версию).
- `npm test` — полный прогон всех воркспейсов (gatekeeper, runtime,
  knowledge-snapshot, infra-контракт, ops, operator-console).
- Продакшн: VPS `news-vps` (SSH-алиас), Docker Compose, релизы —
  `git archive` точного SHA → `scp` → build → `docker compose up -d
  --no-build --no-deps <service>`. Нет коммитнутого деплой-скрипта —
  процедура описана в `docs/VPS_CUTOVER_RUNBOOK.md`.

## Зависимости

- Telegram Bot API — весь продукт вокруг него; webhook, не long-polling.
- `better-sqlite3` — единственное хранилище состояния рантайма (local-first,
  без внешней БД на этом этапе).
- LLM-провайдер (через `provider-adapter.mjs`) — модерация, роутинг,
  переформулировка (выключена), финальный ответ. Абстрагирован, но
  предполагает синхронный HTTP-вызов внутри одного webhook-запроса —
  источник RISK-1 (нет таймаутов/асинхронности, см. BACKLOG.md).
- Docker Compose + общий Traefik на VPS — инфраструктура shared, но
  контейнер/БД/секреты AIchatTG изолированы (`AGENTS.md` Runtime boundary).

## Открытые вопросы

- Простой веб-интерфейс для настроек ассистента без правки кода — нужен
  или достаточно env + операторской консоли для метрик? Обсуждалось,
  не решено.
- Нужны ли ассистент-боту права администратора (`can_delete_messages`) в
  группах — блокирует вторую половину chat-hygiene (BACKLOG HYGIENE-1).
