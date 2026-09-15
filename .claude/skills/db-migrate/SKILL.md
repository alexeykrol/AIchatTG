---
name: db-migrate
description: "Безопасное изменение локальных SQLite-схем AIchatTG и подготовка production migration candidate."
paths:
  - "apps/**/src/database.mjs"
  - "apps/gatekeeper/src/store.mjs"
  - "scripts/aichattg/*migration*"
  - "scripts/aichattg/*runtime-state*"
  - "**/*.sql"
allowed-tools: Read Edit Write Glob Grep Bash
disable-model-invocation: true
---

# Skill: AIchatTG SQLite Migration

## Контекст проекта

AIchatTG использует `better-sqlite3` и отдельные SQLite-файлы на VPS. В проекте
нет PostgreSQL/Supabase target, staging database или разрешения на облачную
миграцию. Не генерировать RLS, Supabase CLI-команды, PostgreSQL-типы или
`psql`-deploy без отдельного архитектурного решения Product Owner.

## Workflow

1. Прочитать фактическую схему и миграции в
   `apps/telegram-runtime/src/database.mjs` либо
   `apps/gatekeeper/src/store.mjs`; не угадывать схему по шаблону.
2. Сохранить ownership markers, `PRAGMA user_version`, idempotency и
   совместимость с существующим файлом БД.
3. Делать миграцию additive. Соблюдать `.claude/INVARIANTS.md`: никакого
   `DROP TABLE`, `TRUNCATE` или безусловного удаления production-данных.
4. Добавить тест перехода с точной предыдущей схемы и проверки сохранности
   строк, индексов, foreign keys и повторного открытия.
5. Запустить целевые тесты и полный `npm test` под Node 20.20.x.
6. Подготовить candidate с точным SHA, data/runtime effect, backup/restore
   планом, rollback consequence и evidence status.

Для импортов runtime-state использовать существующие
`scripts/aichattg/verify-migration-bundle.mjs` и
`scripts/aichattg/import-runtime-state.mjs`; их approval/lease receipts нельзя
подменять общим подтверждением.

## Production gate

Не подключаться к production SQLite, не копировать её и не применять миграцию
без точного Product Owner approval и release lease. Remote-действия выполняются
только по `safe-remote-deploy`; перед изменением нужен backup с проверяемым
restore-планом, после — schema/version, integrity и service verification.

Локально пройденная миграция — только `prepared`, не `deployed` и не
`production-verified`.
