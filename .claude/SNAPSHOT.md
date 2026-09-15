# Project Snapshot — AIchatTG

**Last Updated:** 2026-09-15 UTC (2026-09-14 local)

## Текущее состояние

- **Production-verified:** `telegram-runtime` image `049cc22` (запуск
  2026-09-15 00:20:48 UTC); Moderator и Assistant покрывают 3 чата, знание и
  retrieval включены, rewrite выключен. Operator Console не менялась.
- **Не production:** Gatekeeper. Код, тесты и draft-сценарий существуют, но
  контейнер/маршрут не активированы; Product Owner copy, две HTTPS-ссылки и
  placement в общей консоли остаются решениями владельца.
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
- Acceptance пока не судит фактическую верность ответа данному знанию.
- Удаление пользовательской `/ask@bot` требует `can_delete_messages`; права в
  covered chats не подтверждены.
- Простой веб-интерфейс основных настроек не специфицирован.

## Следующий безопасный шаг

Деплой `049cc22` завершён; health 200, healthy, restart 0, 50 source-файлов
совпали с Git-архивом. Rollback `f51753f` сохранён. Дальнейшую продуктовую
работу выбирать из BACKLOG; текущий одноразовый release lease использован.
