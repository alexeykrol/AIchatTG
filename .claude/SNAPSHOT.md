# Project Snapshot — AIchatTG

**Last Updated:** 2026-09-15 UTC (2026-09-14 local)

## Текущее состояние

- **Production-verified:** `telegram-runtime` image `049cc22` (запуск
  2026-09-15 00:20:48 UTC); Moderator и Assistant покрывают 3 чата, знание и
  retrieval включены, rewrite выключен. Operator Console не менялась.
- **Не production:** Gatekeeper. Код, тесты и draft-сценарий существуют, но
  контейнер/маршрут не активированы; Product Owner copy, две HTTPS-ссылки и
  placement в общей консоли остаются решениями владельца.
- **Новый локальный candidate (`prepared`, ещё не production):** восстановлен
  прежний публичный профиль «ИИ Навигатор»; уборка пустой `/ask` связывает
  конкретную команду с подсказкой и сохраняет реальный Q/A. Два повторных
  замечания владельца и история причины зафиксированы в
  `docs/reports/2026-09-15-assistant-purpose-and-chat-hygiene.md`.
- **Живая приёмка baseline `049cc22`:** 28/28 доставлены; содержание:
  19 passed, 6 partial, 2 failed, 1 inconclusive. 22 платных ответа и 24
  вызова анализатора, без отдельного платного судьи. Новый runtime ещё не
  выложен; меню-пара проверена локально, не в Telegram. Полный отчёт:
  `docs/reports/2026-09-15-assistant-live-baseline.md`.
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
  трёх группах; Assistant — в тестовой. Локальная уборка команды использует
  существующий Guard, без изменения прав. В production `049cc22` пока
  удаляется только hint; считать весь сценарий закрытым нельзя.
- Простой веб-интерфейс основных настроек не специфицирован.

## Следующий безопасный шаг

Деплой `049cc22` завершён; health 200, healthy, restart 0, 50 source-файлов
совпали с Git-архивом. Тот одноразовый release lease использован.
Новый профиль/service-pair candidate локально готов; до его установки нужен
новый точный approval. Затем проверить оба меню-сценария и исправленные
формулировки в закрытом чате в пределах оставшихся 22 вопросов (общий лимит
владельца — 50). Rollback для этого следующего кандидата — текущий `049cc22`.
Оставшиеся ошибки знания/навигации перечислены в QUALITY-2 и не закрыты.
