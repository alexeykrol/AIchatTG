---
paths:
  - "apps/**"
  - "infra/**"
  - "scripts/aichattg/**"
  - "docs/**"
  - "**/.env*"
  - "**/Dockerfile*"
  - "**/docker-compose*"
---

# Правило: AIchatTG Production Safety

## Граница

AIchatTG работает на общем VPS, но владеет только своими контейнерами, SQLite,
webhook-маршрутами и секретами. Доступ к News Digest не становится разрешённым
из-за общего хоста. Перед любым SSH/SCP/SFTP/rsync или remote deploy применять
глобальную процедуру `safe-remote-deploy` и держать одного remote writer.

## Требует точного подтверждения Product Owner и release lease

- deploy/restart/rebuild или иная мутация production-сервиса;
- создание, удаление или перенастройка Telegram webhook;
- изменение production env/config или секретов;
- production-миграция, импорт, запись или удаление данных;
- внешнее Telegram-сообщение, изменение membership/permissions или другое
  действие от имени бота (обычные ответы уже работающего одобренного runtime не
  считаются новой агентской операцией);
- изменение политики платных model/API-вызовов или разовый платный вызов вне
  уже одобренного runtime-потока;
- host-wide Docker, Traefik, logging-driver, DNS, TLS или firewall изменение.

Подтверждение действительно только для названного кандидата. Lease обязан
фиксировать: точный SHA/переменную, сервис и окружение, scope, rollback,
expiration, verification и stop conditions. Общее «можно деплоить» не
расширяется на webhook, секрет, миграцию, внешнее сообщение или соседний
проект.

## До production-действия

Доложить текущий production image/SHA (`not_run`, если не проверен), candidate
SHA, runtime/config/data effects, rollback consequence и evidence как
`passed` / `failed` / `not_run` / `inconclusive`. Затем проверить точность
approval и lease. При несовпадении или истечении — остановиться.

## Автономно локально

Разрешены локальные правки, тесты, ветки, осознанные commits и документация в
границах задачи. Push, commit и зелёные тесты не являются подтверждением
deployment. Staging на shared/remote инфраструктуре не считается локальным и
подчиняется тем же remote- и ownership-проверкам; если создаёт ресурс или
стоимость, нужен соответствующий attention gate.

## Запрещено

- Использовать секреты или production-данные для локальной проверки.
- Читать контейнеры, логи, БД или env другого проекта на общем VPS.
- Деплоить overlay/частичное дерево вместо точного Git source.
- Продолжать после transport/auth failure или подменять его application result.
