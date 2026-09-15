---
title: Backlog
type: backlog
updated: 2026-09-14
---

# Backlog

## Next

- [x] RELEASE-1: `049cc22` production-verified 2026-09-15 UTC; полный test
      matrix, commit/push, точный lease и deploy завершены. Receipt:
      `docs/reports/2026-09-15-runtime-049cc22-deployment.md`.
- [ ] RISK-1: спроектировать durable webhook inbox + per-chat worker recovery.
      Немедленный HTTP 200 разрешён только после надёжной записи валидированного
      update; in-memory очередь может потерять update при crash после ACK.
- [ ] HYGIENE-1: read-only проверить `can_delete_messages` ассистент-бота в
      покрываемых группах. Без прав удаляется только собственная hint-подсказка,
      а не пользовательская команда `/ask@bot`.

## Soon

- [ ] QUALITY-1: добавить отдельную content-grounding acceptance leg, которая
      проверяет ответ на верность выданным фрагментам знания. Нынешний judge
      проверяет поведение, но сознательно не оценивает фактическую опору.
- [ ] GATEKEEPER-1: получить Product Owner copy, две HTTPS-ссылки и решение по
      placement в Operator Console; только затем готовить отдельный activation
      candidate/lease. Исторический import запрещён по умолчанию.

## Later

- [ ] SETTINGS-UI-1: специфицировать простой веб-интерфейс базовых настроек
      ассистента без правки кода.
- [ ] ARCHIVE-BACKUP-1: определить резервное копирование локального
      `.claude/dialogs/`; сам скрипт не удаляет архив, но локальный диск не
      является резервной копией.

## Resolved in current candidate

- [x] RISK-2: Compose passthrough rewrite model/reasoning.
- [x] RISK-3: скрытый hardcoded dialogue cap.
- [x] REQUEST-TIMEOUTS: конечные deadline Telegram/provider без автоповтора.

## Won't do

- In-memory webhook ACK queue без durable inbox: риск невосстановимой потери
  Telegram update после HTTP 200.
