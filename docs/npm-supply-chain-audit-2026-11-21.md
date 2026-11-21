# npm supply-chain audit — 2026-11-21

Статус: нормативная политика установки для этого репо. Дата: 2026-11-21. Среда: Node 20.20.0, npm 10.8.2, linux/amd64 (прод), darwin/arm64 (локально)

## Ландшафт

Срез на 2026-11-20/21. Источники — security-вендоры, GitHub Advisory Database (GHSA, `type=malware`),
changelog `npm/cli`. Где вендоры расходятся в цифрах — указано. Статус уверенности: факты по GHSA и
npm/cli проверены напрямую через API; остальное — по вендорским отчётам.

### 1. Крупные кампании за 12 месяцев (ноябрь 2025 — ноябрь 2026)

| Дата | Кампания | Вектор | Затронуто (IOC) | Источник |
|---|---|---|---|---|
| 24.11.2025 | Shai-Hulud 2.0 | захват токенов мейнтейнеров → `preinstall` + Bun-рантайм, самораспространяющийся червь | ~796 пакетов / 1092 версии (Datadog), напр. PostHog | [Datadog](https://securitylabs.datadoghq.com/articles/shai-hulud-2.0-npm-worm/), [Unit 42](https://unit42.paloaltonetworks.com/npm-supply-chain-attack/) |
| 31.03.2026 | axios | захват npm-аккаунта мейнтейнера; вредоносная зависимость `plain-crypto-js@4.2.1` с postinstall-RAT | `axios@1.14.1`, `axios@0.30.4` (GHSA-fw8c-xr5c-95f9); чистые 1.14.0 / 0.30.3 | [Socket](https://socket.dev/blog/axios-npm-package-compromised), [post-mortem](https://github.com/axios/axios/issues/10636) |
| 22.04.2026 | TeamPCP / Bitwarden | `preinstall` + Bun; payload срабатывал также через `bin` | `@bitwarden/cli@2026.4.0` | [Unit 42](https://unit42.paloaltonetworks.com/monitoring-npm-supply-chain-attacks/) |
| 29.04.2026 | Mini Shai-Hulud (SAP) | `preinstall` → `setup.mjs` | `@cap-js/sqlite@2.2.2`, `@cap-js/postgres@2.2.2`, `@cap-js/db-service@2.10.1`, `mbt@1.2.48` | Unit 42 (там же) |
| 11.05.2026 | Mini Shai-Hulud (TanStack) | pwn-request в GitHub Actions + cache poisoning + кража OIDC из памяти раннера; **валидный provenance** | 42 пакета `@tanstack/*`; к концу дня 373 версии / 169 пакетов (`@opensearch-project/opensearch`, `@uipath/*`) | Unit 42; [Strobes](https://strobes.co/blog/tanstack-npm-supply-chain-attack/) |
| 19.05.2026 | Mini Shai-Hulud (@antv) | захват аккаунта; `preinstall` + Bun + git-зависимость как резерв | 639 версий / 323 пакета за ~1 ч (`echarts-for-react`) | Unit 42 |
| 29.05.2026 | node-ipc | публикация чужим мейнтейнер-аккаунтом | `node-ipc@9.1.6` (GHSA-pvh2-rg5g-69v7) | [StepSecurity](https://www.stepsecurity.io/blog/node-ipc-npm-supply-chain-attack), [THN](https://thehackernews.com/2026/05/stealer-backdoor-found-in-3-node-ipc.html) |
| 01–05.06.2026 | Red Hat / Miasma, IronWorm | захват GitHub-аккаунта сотрудника, orphan-коммиты; валидный SLSA | ≥32 `@redhat-cloud-services/*` | Unit 42; [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-miasma-ironworm-ai-coding-supply-chain-202/) |
| 03.06.2026 | Miasma «Phantom Gyp» | **исполнение через `binding.gyp`** (нет скриптов в package.json — node-gyp раскрывает `<!(cmd)`); закрепление в `.claude/settings.json`, `.claude/setup.mjs`, `.cursor/rules/*`, `.gemini/settings.json`, VS Code tasks | 57 пакетов / 286+ версий за <2 ч (`@vapi-ai/server-sdk`, `ai-sdk-ollama`) | [StepSecurity](https://www.stepsecurity.io/blog/binding-gyp-npm-supply-chain-attack-spreads-like-worm), [Semgrep](https://semgrep.dev/blog/2026/miasma-v2-self-spreading-npm-worm-now-uses-malicious-bindinggyp-file-and-compromises-57-packages/), [Endor](https://www.endorlabs.com/learn/malicious-payload-in-ai-sdk-ollama-npm-package) |
| 14.07.2026 | miasma-train-p1 (AsyncAPI) | коммиты в незащищённые release-ветки → CI-публикация | `@asyncapi/generator@3.3.1`, `@asyncapi/specs@6.11.2`, … | Unit 42 |
| 04.08.2026 | ChainDrop (keyv/cacheable, потомок Mini Shai-Hulud) | захват GitHub-аккаунта мейнтейнера; `preinstall` + Bun; валидный SLSA; распространение через украденные npm-токены | `keyv@6.0.0`, `flat-cache@6.1.24`, `file-entry-cache@11.1.6`, `cacheable@2.5.1`, `cacheable-request@13.0.20`, `cache-manager@7.2.10`, `@cacheable/*`; оценки охвата 11 → 400+ → 800+ | [Microsoft](https://www.microsoft.com/en-us/security/blog/2026/08/04/chaindrop-supply-chain-compromise-anatomy-self-propagating-worm/), [Endor](https://www.endorlabs.com/learn/npm-malware-compromises-keyv-and-cacheable-with-500m-weekly-downloads-and-spreads-to-hundreds-of-packages), [SafeDep](https://safedep.io/blog/keyv-npm-supply-chain-compromise) |
| 23.09.2026 | MemTensor | скомпрометированные пакеты npm+PyPI, стилер `sckit` | пакеты MemTensor | [StepSecurity newsroom](https://www.stepsecurity.io/newsroom) |
| 08.10.2026 | ChainDrop → Tensorlake | `preinstall` + Bun, кража CI/K8s/Vault-кредов | `tensorlake@0.5.144` (GHSA-rqxj-g25x-4v9v) | [THN](https://thehackernews.com/2026/10/tensorlake-npm-package-compromised-to.html) |

Векторы, сведённые в классы (что из этого бьёт по `npm ci`/`npm install`):

1. **Захват аккаунта/CI мейнтейнера** (axios, keyv, @antv, node-ipc, bee-js, WPPConnect) — доминирующий вектор
   2026 г. Часто публикуется через **собственный trusted-publishing пайплайн проекта → валидный provenance**
   (TanStack, Red Hat, keyv, WPPConnect). Вывод вендоров: «provenance необходим, но уже не достаточен».
2. **Install-скрипты** (`preinstall`/`postinstall`) + скачивание Bun-рантайма — основной способ исполнения.
3. **Подтягивание через semver-диапазон** — заражённая версия приходит транзитивно (keyv → flat-cache →
   ESLint; bee-js 13.3.0 → `@ethersphere/swarm-cli@3.7.0`). Окно публикации обычно 1–3 ч до отзыва.
4. **binding.gyp / неявный `node-gyp rebuild`** (Phantom Gyp) — исполнение без скриптов в package.json.
5. **Тайпсквоты и спам-пакеты** — фон: GHSA публикует сотни malware-адвайзори в сутки
   (600 записей за 20–21.11.2026, в основном тайпсквоты/форки `baileys`, «testmetest»-пакеты).
6. **Закрепление в конфигах AI-агентов** (`.claude/`, `.cursor/`, `.gemini/`, `.vscode/tasks.json`) — новое
   с июня 2026 (Miasma, Mini Shai-Hulud, рубин-гем 06.11.2026).

### 2. Активно сейчас (последние 2–4 недели: 23.10 — 21.11.2026)

| Дата | Кампания | Вектор | IOC | Источник |
|---|---|---|---|---|
| 09.11.2026 | SleepyDuck → `@ethersphere/bee-js` | захват 2 GitHub-аккаунтов (мейнтейнер + release-бот); `scripts/generate-version.cjs` → postinstall-загрузчик, Ethereum-C2; **транзитивно через semver** | `@ethersphere/bee-js@13.3.0` (latest ~75 мин), Swarm Desktop 0.56.2, `@ethersphere/swarm-cli@3.7.0`; чистая 13.2.0 | [Socket](https://socket.dev/blog/bee-js-compromise), [THN](https://thehackernews.com/2026/11/hackers-compromise-etherspheres-bee-js.html), [Corgea](https://corgea.com/research/ethersphere-bee-js-13-3-0-swarm-desktop-0-56-2-evjawbreaker-ethereum-c2-november-2026) |
| 12.11.2026 | wfx-loot | 4837 угнанных GitHub-аккаунтов, CI-стилер через PR в GitHub Actions; ≥50 аккаунтов публикуют в npm/PyPI/Go/crates | — (риск будущих публикаций) | [OX Security](https://www.ox.security/blog/thousands-of-github-accounts-hijacked-with-wfx-loot-ci-secret-stealing-malware-via-github-actions-npm/) |
| 15–16.11.2026 | WPPConnect | публикация через собственный trusted-publishing workflow; эксфильтрация env/.env/сессий в **Telegram-бот** | `@wppconnect-team/wppconnect@2.4.1`, `@wppconnect/server@2.10.82` + Docker-теги 2.10.82/2.10.83/latest (версии у вендоров частично расходятся) | [StepSecurity](https://www.stepsecurity.io/blog/wppconnect-compromised-malicious-releases-steal-secrets-and-whatsapp-sessions), [Corgea](https://corgea.com/research/wppconnect-npm-docker-trusted-publishing-telegram-secret-stealer-november-2026/) |
| 16.11.2026 | Hermes Agent backdoor | тайпсквот-пакет, ставит systemd-сервис под управлением Telegram-бота | `@leadstack/crm-connect` (9 версий, удалён) | [SafeDep](https://safedep.io/blog/malicious-npm-leadstack-crm-connect-hermes-agent-backdoor) |
| 19.11.2026 | самораспространяющиеся пакеты | postinstall-стилер env (`KEY/SECRET/TOKEN/PASS`); пакет переименовывает и перепубликует сам себя | `@fedfub/utils` (MAL-2026-20291), `pearx93qja-notthedevs@1.1.8`, 4 пакета `@mrnima/*` | [OSV/vulners](https://vulners.com/osv_mal/OSV:MAL-2026-20291), [OffSeq](https://radar.offseq.com/threat/malicious-code-in-pearx93qja-notthedevs-npm-9eaf4466ef9ee8bd), [Helix](https://helix.ml/threat-watch/i/malicious-npm-packages-mrnima-four-npm-packages-flagged-as-malware-full-machine-compromise-no-patched-versions) |
| фон | ChainDrop / Mini Shai-Hulud семейство | продолжает всплывать (Tensorlake 08.10; Ruby-гем 06.11 с отравлением конфигов AI-инструментов) | — | [Socket feed](https://socket.dev/blog), [Strobes, upd. 15.11](https://strobes.co/blog/tanstack-npm-supply-chain-attack/) |

Не npm, но в том же окне и того же класса: Microsoft `agent-framework` (PyPI, 17–18.11), Optimizely-CDN
crypto-clipper (браузерный JS, 16.11), LiteLLM (PyPI). На наш `npm ci` не влияют.

**Экосистема ML/ONNX — проверено напрямую по GHSA (`type=malware`, `affects=`), 2026-11-21:**

| Пакет | Malware-адвайзори | Прочее | Install-скрипт в latest | Provenance latest |
|---|---|---|---|---|
| `onnxruntime-node` (latest 1.31.1) | нет | — | **да: `postinstall: node ./script/install`** (скачивает бинарники) | **нет** |
| `@huggingface/transformers` (4.3.2) | нет | — | нет | **нет** |
| `@huggingface/jinja`, `@xenova/transformers` | нет | — | — | — |
| `sharp` (0.35.5) | нет | уязвимости libvips/libheif/librsvg: фикс в **≥ 0.35.5** (GHSA-wq5f-xc86-pv6w, 06.10.2026) | нет | SLSA v1 |
| `protobufjs` (8.8.1) | нет | RCE CVE-2026-41242 (≤7.5.4, 8.0.0), Proto6 CVE-2026-44291 (фикс 7.5.6/8.0.2), DoS до 7.6.4 / 8.6.5 — брать **≥7.6.5 или ≥8.6.6** | нет | SLSA v1 |
| `tokenizers`, `@anush008/tokenizers` | нет | — | — | — |
| `better-sqlite3` (наша прод-зависимость) | нет | нет | 11.10.0: `prebuild-install \|\| node-gyp rebuild` + `binding.gyp` | SLSA v1 (13.2.0) |

Итог: **активных компрометаций ML/ONNX-пакетов нет**. Риски — CVE (sharp, protobufjs) и отсутствие
provenance у `onnxruntime-node` / `@huggingface/transformers`, плюс postinstall у `onnxruntime-node`.
Ночные `onnxruntime-node@1.3x.0-dev.*` публикуются ежедневно — semver-диапазон с pre-release их не
должен захватывать; ставить только точный пин стабильной версии.

### 3. Защитные механизмы npm и дефолты

| Механизм | npm 10.8.2 (наш) | npm 11.21.x (Node ^20.17 \|\| ≥22.9 — **совместим с Node 20.20**) | npm 12.2.x (Node ^22.22.2 \|\| ^24.15 \|\| ≥26 — **несовместим с Node 20**) |
|---|---|---|---|
| `min-release-age` (cooldown, дни) | **нет — молча игнорируется** | есть с 11.10.0, default `null` (выкл.); `min-release-age-exclude` с июня 2026 | есть, default `null` |
| `before=<date>` | есть (ручной аналог cooldown) | есть | есть |
| `ignore-scripts` | есть, default `false`. По коду arborist 10.8.2 неявный `node-gyp rebuild` для `binding.gyp` ставится как `install`-скрипт и **тоже пропускается** при `ignore-scripts=true`; но последующий явный `npm rebuild` его исполнит | то же | то же |
| `allowScripts` (политика в package.json) + `strict-allow-scripts` | нет | есть; неодобренные скрипты **выполняются с предупреждением**, пока не `strict-allow-scripts=true` | **скрипты зависимостей и неявный node-gyp заблокированы по умолчанию**; `npm install-scripts approve` |
| `allow-git` / `allow-remote` | нет | есть, default `all` | default **`none`** |
| `npm audit signatures` | есть (с 8.15): проверка ECDSA-подписей реестра + provenance-аттестаций | есть | есть |
| Provenance / trusted publishing | проверка через `audit signatures` | то же | то же |

Важно (факты из инцидентов и кода):

- `npm ci` ставит ровно то, что в lockfile, — `min-release-age` на `npm ci` не действует; cooldown работает
  в момент **генерации** lockfile (`npm install`/`npm update`). Защита `npm ci` = lockfile с integrity +
  точные пины, сгенерированные под cooldown.
- Репозиторный `.npmrc` с `min-release-age=0` молча отменяет пользовательский — держать значение в
  проектном `.npmrc`.
- Provenance больше не доказательство чистоты: TanStack, Red Hat, keyv, WPPConnect шли с валидной
  аттестацией через собственный CI проекта. `audit signatures` ловит подмену tarball, но не
  скомпрометированный пайплайн мейнтейнера.
- Реестр (с июня 2026): high-impact аккаунты уходят в read-only на 72 ч при смене email/использовании
  recovery-кода — снижает, но не устраняет захват аккаунтов.
- Последний релиз 10.x — 10.9.11 (17.11.2026), без security-фиксов установки; 10.x не получит
  cooldown/allowScripts.

### 4. Критические флаги для нашей установки

1. **Node 20 — EOL с 30.04.2026**, и мы на `20.20.0` (12.01.2026), тогда как последний security-релиз
   линии — `20.20.2` (24.03.2026). Рантайм без security-фиксов; npm 12 на нём не встанет.
2. **npm 10.8.2 не имеет cooldown** — `min-release-age` в `.npmrc` молча игнорируется. Минимум — npm
   11.21.x (совместим с Node 20.20) или ручной `--before=<дата-14д>` при генерации lockfile.
3. **`better-sqlite3@11.10.0` имеет `binding.gyp` и install-скрипт** (`prebuild-install || node-gyp
   rebuild`) — ровно класс Phantom Gyp/postinstall. При `ignore-scripts=true` его нужно собирать
   адресно (`npm rebuild better-sqlite3`), а не общим `npm rebuild`.
4. **Пакеты-кандидаты ML-стека**: `onnxruntime-node` — postinstall + без provenance; `sharp` < 0.35.5 и
   `protobufjs` < 7.6.5 / < 8.6.6 — уязвимы. Точные пины стабильных версий, без `^`.
5. **Docker-образ по тегу** (`FROM node:20.20.0-bookworm-slim`) — WPPConnect показал подмену по тегам;
   пиновать по digest.
6. **Конфиги AI-агентов в репо** (`.claude/settings.json`, хуки) — целевой объект закрепления червей
   2026 г.; после любой установки проверять `git status` на неожиданные изменения в `.claude/`,
   `.cursor/`, `.vscode/`.
