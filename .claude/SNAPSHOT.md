# Project Snapshot — AIchatTG

**Last Updated:** 2026-09-15 UTC / local

## Текущее состояние

- **Production, lifecycle `deployed`:** `telegram-runtime` image `852a8d2`
  (запуск 2026-09-15 06:49:50 UTC), healthy / restart 0; конфигурация, schema,
  mounts/routes сохранены. Moderator и Assistant покрывают 3 чата, знание и
  retrieval включены, rewrite выключен. Operator Console не менялась.
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
- PROFILE-2: добавить узкое распознавание составного identity-вопроса,
  регрессии на смешанные учебные вопросы и отсутствие provider/retrieval calls.
  CAP-03 также требует сверки ответа с account-boundary ожиданием frozen plan.
- Простой веб-интерфейс основных настроек не специфицирован.

## Следующий безопасный шаг

Деплой `852a8d2` завершён и запушен, 622 теста прошли без skips; 50 source-файлов
совпали с архивом. Инфраструктура исправна, функциональная приёмка неполна.
Одноразовый release lease использован, rollback `049cc22` сохранён.
Не повторять удаление uncertain команды 524 и не обходить stop harness.
Следующее: локальный PROFILE-2 и проверка меню обычным пользователем в закрытом
чате. Новые image/права/BotFather/тестовый identity требуют своего точного
approval; оставшиеся 16 вопросов не разрешают такие изменения сами по себе.
QUALITY-2 остаётся открытым, источники знания этим релизом не менялись.
