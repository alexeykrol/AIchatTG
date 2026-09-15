# Project Snapshot — AIchatTG

**Last Updated:** 2026-09-14

## Текущее состояние

- **Production-verified:** `telegram-runtime` image `f51753f` (`0.5.1`,
  2026-09-14 21:46 UTC); Moderator и Assistant покрывают 3 чата, знание и
  retrieval включены, rewrite выключен. Operator Console не менялась.
- **Не production:** Gatekeeper. Код, тесты и draft-сценарий существуют, но
  контейнер/маршрут не активированы; Product Owner copy, две HTTPS-ссылки и
  placement в общей консоли остаются решениями владельца.
- **Подготовленный кандидат (не production-verified):** self-description
  и chat-hygiene из `2c02c56`, конечные deadline Telegram/provider, полный
  Compose passthrough rewrite, единый configurable dialogue limit, мягкая
  обработка отказа удаления hint, согласованные документы и безопасные
  Claude/Codex framework-процедуры. До деплоя это не production evidence.

## Исправлено локально

- Assistant profile/help согласованы: reply, `/ask`, `@mention`.
- `TELEGRAM_RUNTIME_ASSISTANT_DIALOGUE_TURN_LIMIT` теперь единственный cap по
  числу ходов; скрытый `.slice(-3)` удалён. Независимый 50k serialized-size
  budget не даёт расширенному окну нарушить provider input contract.
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

Полный локальный test matrix и фиксация candidate SHA. Затем read-only
production preflight и точный release lease для одного сервиса `aichattg-telegram-runtime`:
candidate SHA, current SHA, rollback, scope, expiry, verification и stop rules.
