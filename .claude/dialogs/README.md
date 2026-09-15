# Dialog Archive

Здесь хранится локальный архив JSONL-сессий Claude Code и Codex вне их
служебных каталогов retention.

## Как сохранить текущий диалог

```bash
bash scripts/save-dialogs.sh
# или с темой:
bash scripts/save-dialogs.sh --note "тема диалога"
bash scripts/save-dialogs.sh --source claude
bash scripts/save-dialogs.sh --source codex
```

Идемпотентно: можно запускать сколько угодно раз — копируются только новые/изменённые файлы.

## Структура

```
.claude/dialogs/
  YYYY-MM-DD_<source>_<session-id>.jsonl  # сырой JSONL сессии
  INDEX.md                              # реестр: что за диалог, почему сохранили
  README.md                             # этот файл
```

## Политика коммитов

| `repo_access` | `.claude/dialogs/` |
|---------------|--------------------|
| `private-solo` | локально; не коммитить |
| `private-shared` | локально; не коммитить |
| `public` | локально; не коммитить |

Скрипт не удаляет архив и не задаёт срок хранения. Сырые диалоги могут
содержать приватный контекст и всегда игнорируются Git.

Полное правило: `.claude/rules/dialog-preservation.md`.
