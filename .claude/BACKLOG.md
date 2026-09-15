---
title: Backlog
type: backlog
updated: 2026-09-15
---

# Backlog

## Next

- [ ] CONSOLE-V311: candidate `5e55101` lifecycle `pushed`, исправлены
      склонение и pricing-подпись;33Console tests passed. Для production
      нужны точное PO-разрешение/новая lease/fresh preflight. На сервере3.1.0.
      `docs/reports/2026-09-15-console-v311-candidate.md`.
- [x] CONSOLE-V31: Console3.1.0 `eb0f7fe` production-verified, семь общих
      version/date/time headers + русская Помощь, лишние плашки убраны.
      Timestamp сравнен с реальным start (delta0.562637s); runtime/drafts сохранены.
      Lease/master закрыты; Chrome7/7 passed. Два copy-дефекта Analytics
      (склонение/English pricing ID) требуют отдельного hotfix. Receipt:
      `docs/reports/2026-09-15-console-v31-deployment.md`.
- [x] MODERATOR-MENU-1: stale chat-scoped `/ask` removed from Moderator's
      test-chat command menu at21:42:34UTC. Exact one-call cleanup,18-cell
      before/after checks, unchanged app snapshots passed; lease/master closed.
      Client refresh not_run; HYGIENE-1 remains separate. Receipt:
      `docs/reports/2026-09-15-moderator-menu-cleanup.md`.
- [x] CONSOLE-V3: русская панель `82cb8c6` выложена отдельно от Assistant;
      Settings/Markdown сохраняют только versioned drafts, не применяют их.
      Исправлена гонка выбора домена; 30Console tests,29source-file match,
      read-only production API/permissions passed. Receipt:
      `docs/reports/2026-09-15-console-v3-deployment.md`.
- [ ] CONSOLE-COST-1: полный metadata-only usage ledger и ограниченная
      агрегация истории. Текущая аналитика честно показывает unknown, если
      квитанции оплаченных стадий/кэша неполны; не считать это нулевой стоимостью.
- [x] VERSION-1: Assistant `2.4.37` от `15.09.2026` выложен в image `335a35a`.
      Footer всех существующих send paths, final-part-only transport, bare
      model memory, canonical metadata и version-bump release guard покрыты
      тестами; правила общие для Codex/Claude. История `2.4.35`/`2.4.36`
      сохранена как provenance. Новая live Telegram приёмка `not_run`.
      Receipt: `docs/reports/2026-09-15-assistant-2.4.37-deployment.md`.
- [x] COVERAGE-COPY-1: финальные три абзаца владельца из `541a2de` заменили
      additive-вариант; дословно выложены в `0b54148`. Исправлено перекрытие
      текста в domain boundary; санкции/модерация не менялись. Receipt:
      `docs/reports/2026-09-15-runtime-0b54148-deployment.md`.
- [x] HELP-1: menu-first Help выложен в `0b54148`; список возможностей
      сохранён, identity-grounding восстановлен, prompt и Help согласованы.
      Клиентская приёмка остаётся отдельным открытым пунктом HYGIENE-1/INLINE-1.
- [ ] INLINE-1: отключение inline владельцем подтверждено через `getMe`
      2026-09-15 18:47:46 UTC; проверить обычный @mention в клиенте отдельно.
      Не включать inline или новые webhook update types без нового решения.
- [x] RELEASE-3: `5600afd` deployed2026-09-15 16:07:36UTC;55-file source
      match, preserved config/schema/routes, healthy/restart0, rollback852a8d2.
      New live Telegram answer/menu acceptance not_run. Receipt:
      `docs/reports/2026-09-15-runtime-5600afd-deployment.md`.
- [ ] ROUTING-1: отдельное offline-уточнение content/value compound boundary
      (blind-11 analyzer miss) и определения risk flags (blind-06/07).
      Не переписывать gold под модель. Новые платные проверки требуют новой
      точной авторизации; оба прежних experiment lease исчерпаны/закрыты.
- [x] RELEASE-1: `049cc22` production-verified 2026-09-15 UTC; полный test
      matrix, commit/push, точный lease и deploy завершены. Receipt:
      `docs/reports/2026-09-15-runtime-049cc22-deployment.md`.
- [ ] RISK-1: спроектировать durable webhook inbox + per-chat worker recovery.
      Немедленный HTTP 200 разрешён только после надёжной записи валидированного
      update; in-memory очередь может потерять update при crash после ACK.
- [ ] HYGIENE-1: завершить приёмку уборки пары «команда + hint» в `852a8d2`;
      runtime использует существующий Moderator Guard.
      Read-only права уже проверены: Moderator имеет delete/restrict во всех
      трёх группах, Assistant delete — в тестовой. Живой synthetic MENU-01:
      hint удалён, команда получила not-found; uncertain fenced, без повтора.
      Нет Moderator receipt для команды. Проверить обычного пользователя в
      закрытом чате; не менять права/токен из неподтверждённой гипотезы.
- [x] PROFILE-1: основные вопросы о возможностях и способах обращения
      используют «ИИ Навигатор», а не технический fallback; CAP-01/USE-01/
      USE-02 прошли живую проверку содержания на `852a8d2`. CAP-03 partial:
      цели курса перечислены, account-boundary подожидание не выполнено.
- [ ] PROFILE-2: identity routing теперь исправлен реестром в5600afd и
      измерен; прежняя anchored-regex рекомендация superseded. Проверить live
      ответ и пропущенную в CAP-03 границу общих правил/операций аккаунта.
      Self теперь использует модели при knowledge-enabled; zero-call bypass
      не является текущим требованием этого принятого кандидата.
- [ ] RELEASE-2-ACCEPTANCE: `852a8d2` deployed, инфраструктура passed,
      приёмка не завершена. 622 offline tests passed; 6 live вопросов,
      content 4 passed / 1 partial / 1 failed; MENU-02/MIXED-RAG not_run после stop.
      Receipt: `docs/reports/2026-09-15-runtime-852a8d2-deployment.md`.

## Soon

- [ ] QUALITY-2: закрыть конкретные результаты живого прогона `049cc22`:
      NAV-01 (границы курсов/актуальность), NAV-07 (открытая лекция),
      CONCEPT-02 (Parent–Child coverage), ORG-03 (source URL не destination),
      ORG-04 (community navigation), ORG-02 (противоречие инструкций входа).
      Не менять источники/допуск production молча. Квитанции и диагнозы:
      `docs/reports/2026-09-15-assistant-live-baseline.md`.
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
