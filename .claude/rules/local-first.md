---
paths:
  - "**/db/**"
  - "**/database/**"
  - "**/schema/**"
  - "**/migrations/**"
  - "**/models/**"
  - "apps/**/src/database.mjs"
  - "apps/gatekeeper/src/store.mjs"
---

# Правило: Local-First SQLite

AIchatTG использует SQLite и `better-sqlite3` локально и на VPS. SQLite здесь
не временная ступень к Supabase/PostgreSQL, а текущая архитектурная граница.

## Workflow

1. Изменить схему и миграцию в принадлежащем модулю коде.
2. Выполнить миграцию только на временной локальной БД/fixture.
3. Проверить переход с точной предыдущей версии, сохранность данных,
   idempotency и повторное открытие.
4. Запустить релевантные и полные тесты.
5. Подготовить production candidate; не применять его на VPS без точного
   Product Owner approval и lease.

Облачная БД, staging database или смена движка требуют отдельного
архитектурного решения. `/db-migrate` обслуживает текущие SQLite-схемы и не
предполагает Supabase.
