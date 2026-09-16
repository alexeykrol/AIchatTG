# Project Snapshot — AIchatTG

**Last Updated:** 2026-09-16 UTC / 2026-09-15 local

## Текущее состояние

- **Porn-spam, lifecycle `production-verified`:** exact runtime `a41518f`,
  семантическое подозрение на порнографический спам ведёт по существующему
  ban_purge без предупреждения. Local946passed/5skips, review/source guard passed;
  реальная модель не проверялась. Source pushed; Assistant2.4.38/16.09.2026,
  старт04:32:23.874617151UTC, image dd64eee0, healthy/restart0.
  Exact PO approval принят; одна recreation,0rollback.58-file match, footer,
  config/schema/mounts/routes/logging/Console preservation и HTTPS/auth passed.
  Повтор04:34:18UTC; lease consumed, SSH closed04:34:43UTC. Consolef650fe8
  остаётся3.2.0. Rollback335a35a; удалённые сообщения не восстанавливает.
  `docs/reports/2026-09-16-porn-spam-policy-deployment.md`.
- **Отдельно, не реализовано:** `/ask` reply дошёл до обоих ботов, но router
  rejected→manual_review→Assistant skipped, поэтому нет ответа/уборки.
  PO выбрал Assistant-judges для адресованных ему вопросов и Moderator-enforces;
  ordinary posts остаются Moderator-judges. Read-only review получен; после
  «Давай - все делай.» выдан bounded local charter Assistant в isolated worktree.
  Root сохраняет acceptance/integration/commits; готового кандидата/lease нет.
 30-second prompt/no-silence UX включён. Это не частьa41518f и не safety bypass.
  `docs/proposals/2026-09-16-ask-protocol-charter-v1.md`.
- **Console3.2.0, lifecycle `production-verified`:** source `f650fe8`,
  релиз2026-09-15T23:12:03Z, StartedAt23:12:04.671980044Z, image6f768088.
  Проверенная история pushed; exact Git archive без локальных Moderator-файлов.
  Последние5 вопросов:4 полностью оценены,1 partial/unknown; среднее$0.0065898
  по4, полный итог5 остаётся unknown. Root787passed/5fixture-skips/0failed;
  Console41/41,31sourcehashes,7headers/API/HTTPS/auth, реальная арифметика и
  независимый обычный Chrome passed. Final query13.58ms, healthy/restart0.
  Изменён только Console release timestamp; runtime335a35a/Assistant2.4.37,
  остальные config/routes/schema/drafts сохранены. RollbackConsole3.1.0/eb0f7fe.
  Lease consumed, SSH closed23:13:28UTC; одна recreation,0rollback.
  `docs/reports/2026-09-15-console-v32-deployment.md`.
- **Отдельная очередь private Review:** Moderator position1, PO назначил его механическим
  исполнителем следующего деплоя; root сохраняет integration/lock/acceptance.
  Source1829573/Console3.3.0 принят, lifecycle `pushed`, не deployed.
  Два P2 и fingerprint bypass исправлены; root905passed/5skips,
  Console159/159, independent review/source guard passed. Shared hook строго
  disabled без store/collector/sender; Help это объясняет. Lease пока нет.
  Следующий LOCAL contract-only bridge charter передан Moderator, frozen
  worker source сохраняется. Предложение bridge получено/сохранено, но не принято:
  нужны PO решения о приоритете основной защиты при сбое Review и сохранении
  pseudonymous меток после erase. Code reservations/lease не выданы.
  `docs/reports/2026-09-15-moderation-bridge-review.md`.
  `docs/RELEASE_QUEUE.md`; никаких SSH/production полномочий не передано.
- **Новые feature workstreams, local-only:** PO-start Moderation review и
  Analytics last-five costs проверены. База9d326f4; страницы/new modules
  разделены, общие Console/runtime entrypoints/schema/env/Compose/root docs
  пишет только интегратор. Charters в `docs/proposals/2026-09-15-*-charter-v1.md`.
  Оба worker приняли ownership. Moderator retention утверждён: бессрочно до
  ручного удаления; local contract v1–v5 accepted, private erase с повторным
  подтверждением, uncertain verdict audit-only. V4 делает benign retained
  observations видимыми и удаляемыми, без признака подозрения/уведомлений.
  Recipient/principal/production
  limits ещё не утверждены; реальные сбор/уведомления выключены.
  Standalone3.1.1 включён в production3.2.0.
  На текущем checkpoint production3.2.0/f650fe8 + runtimea41518f;
  активной lease/SSH нет.
- **Cost diagnosis, read-only passed22:33:50UTC:** из последних5 записей все
  имеют answer/analyzer tokens,4 имеют exact event-level no-router proof,1 нет.
  Это ещё не4 подтверждённых цены: rate/eligibility/stage checks впереди.
  Один bounded query7.18ms,0writes/private-text exports; app snapshots identical.
  SSH closed22:34:16UTC. `docs/reports/2026-09-15-console-cost-metadata-diagnostic.md`.
- **Standalone release superseded by3.2.0, lifecycle `pushed`:** Console3.1.1
  candidate `5e55101` исправляет только склонение «чат» и человекочитаемые
  тарифные подписи/дату в Analytics. Root779passed/5fixture-skips/0failed;
  Console33/33/source guard/review passed. На сервере остаётся3.1.0 `eb0f7fe`.
  Активной lease/SSH нет; main не равен deployed source. Decision:
  `docs/reports/2026-09-15-console-v311-candidate.md`.
- **Админка 3.1.0, lifecycle `production-verified`:** image `eb0f7fe`, релиз
  2026-09-15T22:04:32Z, реальный старт22:04:32.562637294Z (delta0.562637s).
  Семь вкладок с общей версией/датой/временем и русской Помощью, лишние
  вводные плашки убраны. Один новый Console-only env `OPERATOR_CONSOLE_RELEASED_AT`.
  Root777passed/5fixture-skips/0failed из782; Console31/31, migration9/9 passed.
  Два production checks,31sourcefiles,7headers/API/HTTPS/auth passed; runtime335a35a,
  настройки/схема/маршруты/черновики не изменены. RollbackConsole82cb8c6.
  Lease/master закрыты22:07:43UTC; Chrome7/7 passed, но Analytics имеет
  два copy-дефекта (склонение «чат» и English pricing ID); отдельный hotfix.
  `docs/reports/2026-09-15-console-v31-deployment.md`.
- **Moderator menu, lifecycle `production-verified`:** в21:42:34UTC удалена
  одна stale chat-scoped команда `/ask` у `@ai_akrolmoder_bot` в тестовом чате.
  Один API delete,38reads,18-cell before/after passed; runtime335a35a и
  Console82cb8c6 без изменений, healthy/restart0. Lease/master закрыты21:46:03UTC.
  Клиентский refresh not_run; меню Assistant и HYGIENE-1 не затронуты. Receipt:
  `docs/reports/2026-09-15-moderator-menu-cleanup.md`.
- **Предыдущая админка, lifecycle `production-verified`:** Console v3, image `82cb8c6`, запуск21:23:28UTC;
  шесть русских страниц, единое меню, versioned drafts настроек/Markdown,
  аналитика75 записанных вопросов (стоимость75 unknown, не ноль).
  Root780/780 + historical29/29 + migration9/9 passed; postverify21:24:28UTC
  healthy/restart0,29source files match, auth/API/draft permissions passed.
  Public HTTPS/auth probe21:25:00UTC passed. Assistant/runtime/DB/routes не
  менялись. RollbackConsole5e67451, папку новых черновиков сохранять.
  Повтор21:26:58UTC passed, analytics18ms; lease/master закрыты21:27:13UTC.
  Во внешнем обычном Chrome визуально прошли Settings/Domains/Analytics;
  владелец начал пользоваться вкладкой, автоматизация остановлена. Остальные
  три страницы проверены по HTTP/source, визуально в этом проходе not_run.
  Точная квитанция и визуальная проверка:
  `docs/reports/2026-09-15-console-v3-deployment.md`.
- **Предыдущий production, lifecycle `production-verified`:** Assistant **2.4.37 от 15.09.2026**, image `335a35a`, запуск
  21:01:48 UTC. Восстановлен footer в каждом фактически отправленном ответе,
  один раз внизу последней части. Body-only память и утверждённый текст сохранены.
  Единая metadata и release guard закреплены для Codex/Claude; 758 root tests,
  29 исторических, 9 migration safety passed. Проверка 21:02:15 UTC: healthy/
  restart 0, 57 source-файлов совпали, четыре offline transport cases passed;
  env/schema/routes/mounts/Console не изменены. Rollback `0b54148`.
  Повторная проверка 21:04:31 UTC прошла; lease/master закрыты. Receipt:
  `docs/reports/2026-09-15-assistant-2.4.37-deployment.md`.
  Новые paid/Telegram проверки `not_run`; старые live acceptance gaps открыты.
- **Предыдущий production, lifecycle `production-verified`:** `0b54148`, запуск 20:16:45 UTC,
  healthy/restart 0. Выложены menu-first Help и финальные три абзаца владельца
  дословно (supersedes additive `183d7f9`). Исправлено перекрытие текста в
  knowledge-enabled domain boundary. Правила модерации/санкции не менялись.
  688 текущих тестов, 29 исторических с квитанциями, 9 migration tests прошли.
  Повторная проверка 20:20:00 UTC passed: 55 source-файлов совпали;
  env/schema/routes/mounts/Console сохранены.
  Rollback `5600afd`; новая Telegram/client приёмка `not_run`. Receipt:
  `docs/reports/2026-09-15-runtime-0b54148-deployment.md`.
- **Исторические тесты:** frozen routing проверяется на точном `5600afd`,
  текущие маршруты и provider-boundary — на текущем коде. Старые gold,
  артефакты платных экспериментов и source hashes не менялись.
- **Inline-setting:** владелец отключил inline в BotFather; `getMe`
  подтвердил `supports_inline_queries=false` в 18:47:46 UTC. Проверка была
  read-only; свежая проверка поля ввода/доставки ответа остаётся `not_run`.
- **Предыдущий production, lifecycle `deployed`:** `telegram-runtime` image `5600afd`
  (запуск 2026-09-15 16:07:36 UTC), healthy / restart 0; конфигурация, schema,
  mounts/routes сохранены. Moderator и Assistant покрывают 3 чата, знание и
  retrieval включены, rewrite выключен. Operator Console не менялась.
- **Новый реестр доменов:** six-domain Markdown registry, multi-domain
  attribution и routingDiagnosis выложены. 55 source-файлов совпали с архивом;
  повторная проверка16:10:06UTC passed. Rollback852a8d2 сохранён. Self-вопросы
  теперь могут вызывать модели; tuples/лимиты не менялись. Receipt:
  `docs/reports/2026-09-15-runtime-5600afd-deployment.md`.
- **Замер только маршрутизации:**104 попытки/103 результата; новый router28/28,
  analyzer26/27; один content/value miss, два расхождения risk flags и один
  неопределённый запрос без повтора. Отчёт и USD-учёт:
  `docs/reports/2026-09-15-routing-measurement-result-v2.md`.
- **Не production:** Gatekeeper. Код, тесты и draft-сценарий существуют, но
  контейнер/маршрут не активированы; Product Owner copy, две HTTPS-ссылки и
  placement в общей консоли остаются решениями владельца.
- **Выложено в `852a8d2`:** восстановлен
  прежний публичный профиль «ИИ Навигатор»; уборка пустой `/ask` связывает
  конкретную команду с подсказкой и сохраняет реальный Q/A. Два повторных
  замечания владельца и история причины зафиксированы в
  `docs/reports/2026-09-15-assistant-purpose-and-chat-hygiene.md`.
- **Живая приёмка baseline `049cc22`:** 28/28 доставлены; содержание:
  19 passed, 6 partial, 2 failed, 1 inconclusive. 22 платных ответа и 24
  вызова анализатора, без отдельного платного судьи. Исторический отчёт:
  `docs/reports/2026-09-15-assistant-live-baseline.md`.
- **Живая приёмка `852a8d2`:** 6/6 доставлены, содержание 4 passed / 1 partial / 1 failed.
  CAP-03 не отделяет общие правила от операций с личным аккаунтом.
  Составное «Кто ты и как тебя зовут?» не распознано. Hint 525 удалён, команда
  524 получила от Guard `message to delete not found`, uncertain без повтора.
  Moderator receipt для синтетической команды отсутствует; человеческий
  сценарий не проверен. Прогон остановился, MENU-02/MIXED-RAG не отправлены.
  Общий лимит использован на 34/50 вопросов. Receipt:
  `docs/reports/2026-09-15-runtime-852a8d2-deployment.md`.
- **Вошло в проверенный production `049cc22`:** self-description
  и chat-hygiene из `2c02c56`, конечные deadline Telegram/provider, полный
  Compose passthrough rewrite, единый configurable dialogue limit, мягкая
  обработка отказа удаления hint, согласованные документы и безопасные
  Claude/Codex framework-процедуры в репозитории. Receipt:
  `docs/reports/2026-09-15-runtime-049cc22-deployment.md`.

## Исправлено и проверено

- Assistant profile/help согласованы: reply, `/ask`, `@mention`.
- `TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TURN_LIMIT` теперь единственный cap по
  числу ходов; скрытый `.slice(-3)` удалён. После 50k-проекции диалога весь
  input router/analyzer/answer ограничен 60k с сохранением самых новых ходов.
- Telegram API: deadline 15 s по умолчанию. Provider: 45 s. Timeout остаётся
  неоднозначным результатом и не ретраится автоматически.
- Compose передаёт rewrite model/reasoning и оба timeout-параметра.
- Отказ Telegram удалить временную `/ask`-подсказку логируется как cleanup
  failure и не отменяет уже доставленный ответ.
- PreCompact больше не stage/commit/редактирует SNAPSHOT; `/finish` не скрывает
  красные тесты; repo-access switch не делает bulk staging.
- Локальный dialog archive сохраняет доступные Claude Code и текущую Codex
  JSONL без собственного retention и никогда не коммитит сырые диалоги.
- История указаний Product Owner и её сверка с реализацией сохранены в
  `docs/reports/2026-09-14-owner-instruction-reconciliation.md`.

## Известные проблемы и решения

- Webhook всё ещё ждёт полный конвейер. Немедленный HTTP 200 без durable inbox
  создаёт риск потери update при падении процесса после acknowledgement;
  безопасная очередь требует отдельного storage/recovery design и миграции.
- Ручная source-backed приёмка 28 ответов выполнена. Автоматическая
  content-grounding acceptance leg остаётся открытой; найдены смешение курсов,
  неточная ссылка на открытую лекцию, пробел Parent–Child, неверная роль
  source URL, пробел Discord и противоречие инструкций входа.
- Права read-only проверены: Moderator уже может удалять сообщения во всех
  трёх группах; Assistant — в тестовой. Уборка команды в `852a8d2` использует
  существующий Guard. Отказ синтетического прогона не доказывает отсутствие
  прав или ошибку обычного человеческого сценария. Нужна его прямая проверка;
  права, BotFather и удаление другим токеном не менялись.
- PROFILE-2: прежняя regex-only рекомендация заменена реестром доменов.
  Составной identity распознаётся в замере; live answer/account-boundary
  приёмка остаётся открытой. Нельзя обещать отсутствие provider calls.
- ROUTING-1: offline-уточнение content/value составного вопроса и определения
  risk flags; эталонный набор не подгонять под результаты модели.
- Простой веб-интерфейс основных настроек не специфицирован.

## Следующий безопасный шаг

Menu-first Help и финальный текст владельца выложены в `0b54148` и запушены;
688 текущих, 29 исторических с квитанциями и 9 migration tests прошли.
55 source-файлов совпали с архивом. Rollback `5600afd` сохранён.
Не выдавать успех frozen lane или offline container check за новую платную
или клиентскую приёмку. Следующий release требует нового exact approval/lease.
Не повторять удаление uncertain команды 524 и не обходить stop harness.
Следующее: offline ROUTING-1, live PROFILE-2 и проверка меню обычным пользователем в закрытом
чате. Новые image/права/BotFather/тестовый identity требуют своего точного
approval; оставшиеся 16 вопросов не разрешают такие изменения сами по себе.
QUALITY-2 остаётся открытым, источники знания этим релизом не менялись.
