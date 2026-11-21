---
title: Backlog
type: backlog
updated: 2026-11-19
---

# Backlog

## Next

- [ ] **OWNER-REVIEW-QUEUE — владелец как арбитр на закрытом тесте (слово владельца 20.11.2026).**
  Закрытое тестирование, 2–4 недели, может быть месяц: каждый день владельцу уходят 5–10 настоящих
  вопросов с ответом системы и вердиктом судьи; он пишет подробные комментарии. Нужно: (1) отбор
  пар — в первую очередь сработавшие пробелы знаний, парадоксы, расхождения судьи и низкая
  уверенность; (2) удобная форма разбора (вопрос, ответ, найденные записи, вердикт судьи с кодами
  Н1–Н5, поле комментария, оценка «верно / неверно / как надо»); (3) комментарии сохраняются как
  эталон: калибровка судьи («старшего»), правки базы и промптов, повторный прогон. Без
  идентификаторов пользователей. Канал доставки и форму решить до старта теста. Основа — раздел 15
  `~/Code/BestMentor_Plugin/docs/senior-service-concept.md`.

- [ ] **KNOWLEDGE-GAP-LOOP — суперважно (слово владельца 20.11.2026).** Ассистент никогда не
  говорит «нет», но каждый случай, где он *сказал бы* «нет», — самый ценный сигнал продукта:
  «тогда мы понимаем, на какие вопросы у нас нет знаний в нашей базе знаний. И тогда их надо
  анализировать, для того чтобы понять, что добавить в базу знаний. Это и есть один из
  фундаментальных способов, как мы улучшаем наш продукт.»
  Петля: (1) рантайм пишет отдельное событие `assistant_knowledge_gap` — вопрос, причина, ближайший
  найденный материал; без идентификатора пользователя (модель согласия — `docs/reports/2026-11-19-research/consent-model-grokbot-legal.md`);
  (2) регулярный разбор журнала: группировка похожих вопросов, отделение «знания нет в базе» от
  «знание есть, поиск не нашёл» (второе — дефект поиска, а не базы); (3) решение «что добавить в
  базу» — для книги/курса это вопрос к автору; (4) после пополнения — повторный прогон тех же
  вопросов. Тот же сигнал в стенде: поле `knowledge_gap` в `answers.jsonl`. Связано с журналом
  спроса из концепции «старший консультант» и с журналом промахов (`misses.tsv`) из правила о базах
  знаний. Первый шаг (событие и поле) — в работе 20.11.
  Уточнение владельца 20.11: вопрос вне всех наших баз тоже не получает отказа — ответ из общих
  знаний модели с пометкой «это вне материалов». Такие ответы — разновидность CAC (вовлечение);
  у нас и тут есть преимущество — профиль пользователя. В журнале они идут отдельно от пробелов
  внутри темы: `off_domain` против `in_domain_gap`.

- [ ] **UNIT-ECONOMICS — ключевая метрика прогонов (слово владельца 20.11.2026).** «Ключевая
  метрика для нас — это средняя цена затрат на вопрос, на количество знаков, на минуту […] сколько
  стоит один ответ на вопрос, сколько стоит диалог из пяти вопросов, сколько стоит диалог из 10
  вопросов, учитывая, что каждый следующий ответ подразумевает накопление контекста […] Как только
  мы получаем эти цифры, мы фактически получаем себестоимость. Это значит, что мы примерно
  понимаем, какую маржу назначить.»
  Что нужно: (1) в каждом прогоне — цена ответа (среднее, медиана, 90-й перцентиль), цена на 1000
  знаков ответа, время ответа; отдельно по типам вопросов и по «в базе / пробел / вне баз»;
  (2) прогон **диалогов** на 1, 5 и 10 ходов (синтетический собеседник задаёт уточнения) — цена
  хода растёт с накоплением контекста, это и мерить; (3) та же таблица для каждой модели
  (Claude → OpenAI → открытые модели → балансировщик), чтобы сравнивать качество и себестоимость
  рядом. Учесть, что в бою глубина памяти диалога сейчас 3 хода (`ASSISTANT_DIALOGUE_TURN_LIMIT`)
  — это прямо влияет на цену 10-ходового диалога и на качество; глубину тоже мерить как параметр.
  Итог — таблица себестоимости для решения о цене и марже (цены для пользователей — стоп владельца).

- [ ] CONSOLIDATION (решение владельца 19.11.2026): одна линия — AIchatTG, `agi2claude` и
  `agi` — остановленные доноры; карта — `GOAL-MAP.md`, раздел 2. Шаги: (1) исследование
  доноров → `docs/reports/2026-11-19-research/harvest-*.md`; (2) единый реестр «что берём» и
  план → `docs/proposals/2026-11-19-consolidation-plan.md`; (3) перенос по плану, первым —
  вход «вопрос → ответ с номерами записей» и прогон на 100 вопросах стенда; (4) перенос
  обоих доноров в `~/Code/Доноры` и правка путей в карте и документах.
  Деньги на шаги 1–2 — траншами по $20 со стопом и отчётом владельцу после каждого
  (решение 19.11, пакет решений §1.5а); шаги 3–4 — после ответа «паритет или нет».
- [ ] OWNER-DECISION-PACKAGE (19.11.2026): ждёт слова владельца —
  `docs/proposals/2026-11-19-owner-decision-package.md` (кредиты API, коридор USD500,
  лицензия и имя плагина) и `docs/proposals/2026-11-19-answer-quality-definition.md`
  (Р1–Р3).
- [ ] SENIOR-SERVICE-CONCEPT (19.11.2026, обсуждение, не план): цель владельца —
      агент на API догоняет и превосходит дженерик по качеству ответа при одной
      базе; модель «младший/старший консультант», диспетчер на нашей стороне,
      общий журнал спроса, платформа для экспертов, бесплатный плагин как
      лид-магнит, маркетплейс в бэклоге. Ассистент — один из входов к общему
      сервису ответов. Шаг К1 (паритет на стенде, оценка USD50–100) ждёт «да»
      владельца и бюджет; платных вызовов not_run.
      `docs/proposals/2026-11-19-senior-service-concept.md`; основной документ
      `~/Code/BestMentor_Plugin/docs/senior-service-concept.md` (b9b2b13);
      замеры `docs/reports/2026-11-19-assistant-vs-agi2claude-comparison.md`.
- [x] CURRENT-AD-9809:24September13:56UTC one delete+one immutable-author ban,
      readbackkicked/until0 and native absence. No retries or earlier replays.
- [ ] SOURCE-EVIDENCE-SELECTOR: real acceptance of approvedd8e stopped on3rd
      case with threat_evidence_not_verbatim;2passed/17not_run,3calls,
      upperUSD0.1778986. Replace provider-generated quotation with code-owned
      source selection, preserving strict semantic/action gates. New source,
      actual evaluation and deployment remain separate exact gates.
      `docs/reports/2026-09-24-advertising-live-acceptance-stop.md`.
      Local repair prepared as c019a35/2.4.45:1,542passed/5skips, exactsource
      guard; no new actual-model call or deployment. New bounded decision:
      `docs/proposals/2026-09-24-source-evidence-selector-approval.md`.
- [x] CURRENT-PORN-9780-9799: exact owner-authorized deletion+ban24September
      11:09UTC, twoACKeach, readbackbothkicked/until0. No mutationretry;
      firstuncertainreceipt preserved and reconciled readonly. Production2.4.43
      unchanged. `docs/reports/2026-09-24-two-porn-posts-enforcement.md`.
- [ ] PORN-PROFILE-RECURRENCE: actual clean false negative confirmed24September.
      Candidate d8e5583/2.4.44, lifecycleprepared; v2profile-funnel supplement,
      14synthetic controls,1,528passed/5skips,migration9/9/sourceguard.
      Real-model test pending approval (max30calls/USD2/30min), not_run.
      No push/deploy/historical action; currentproduction2.4.43 unchanged.
      `docs/reports/2026-09-24-porn-profile-recurrence.md`.
- [ ] NATIVE-ACCEPTANCE-2.4.41: provider-only follow-up passed5safe inputs/
      12real calls/37,462tokens, upperUSD0.24941862. Native delivery/repeat/
      cleanup still not_run: needs authorized ordinary test actor, no exempt
      bot/creator bypass. Original website question routes assistant-self on
      legacy and out_of_corpus on dispatch; real legacy answer is truthful but
      not exact boundary copy. Separate acceptance decision if modes must
      converge. Closed run; no remaining paid/external authority.
      `docs/reports/2026-09-19-assistant-2.4.41-live-acceptance.md`.
- [x] SAFETY-CONTRACT-ALIGNMENT: Assistant2.4.41/exacte523485 deployed and
      production-verified19.09 22:07UTC. Strict schema/prompt alignment and safe
      rejection diagnostics; approved irrelevant-question body preserved.
      Isolated1164passed/5skips, integrated1450passed/5skips. Paid/live-model
      follow-up is partial as above; exact historical invalid field unknown.
      `docs/reports/2026-09-19-assistant-2.4.41-deployment.md`.
- [x] REVIEW-RELEASE-RETRY: exact8a2b27f production-verified23September16:31UTC,
      Assistant2.4.42/Console3.4.0, retained binding/store preserved.1470tests/
      5skips, migration9/9, exact images/actualconfig/sourcehashes/footer,
      schema/drafts/health/HTTPS/auth/webhooks passed. Oneactivation each,
      0rollback/reprovision/paidcalls/deletions. Lease/master closed.
      `docs/reports/2026-09-23-review-8a2b27f-deployment.md`.
- [ ] REVIEW-LIVE-ACCEPTANCE: Review enabled, but0capture/cases at deployment;
      real capture→private notice→manual decision/erase not_run, needs separately
      scoped actor/input/write authority. Rendered browserQA blocked before
      auth/render; HTML/API proofs passed, not a visual screenshot proof.
- [x] CURRENT-BOOK-POST-9770: deleted23September23:09:43UTC; exact nativeauthor
      banned23:09:44UTC under fresh explicitPO fullprotocol instruction.
      Both API acknowledgements/readbackkicked/nativeabsence passed; no retry,
      replay/DBwrite/model/redeploy. Lease/masterclosed. Sameauthorpurge is
      inherent to Telegramsupergroupban; no unrelatedauthor targeted.
      `docs/reports/2026-09-23-advertising-post-9770-enforcement.md`.
- [x] ADVERTISING-PRIMARY-POLICY: exactccea9af/2.4.43 deployed24September05:26UTC,
      lifecycleproduction-verified. Primaryrecognition supplement +truthful
      ban/purgecompletion; sanctionsremaincode-owned.1512passed/5fixture skips,
      migration9/9,62sourcehashes/footer/config/schema/ReviewIPC/HTTPS/webhooks.
      Consoleunchanged;1runtimeactivation/0rollback/paidtests/historicalactions.
      Lease/masterclosed. `docs/reports/2026-09-24-advertising-2.4.43-deployment.md`.
- [ ] ADVERTISING-MODEL-ACCEPTANCE: real semantic recognition/precision/recall
      stillnot_run. Injected24syntheticlabels are contract evidence only;
      no paid evaluation or new native test action authorized by completedlease.
- Historical preparation: fresh23September book-promotion recurrence while
      Review remains off. Current candidate8a2b27f is prepared, replacingebf0a8a:
      Assistant2.4.42/Console3.4.0, planned23September, retains e523485;
      1470passed/5skips, migration9/9/source guard passed. Five local false
      positives fixed; exact new native identity still not reconciled.
      Not pushed/deployed. Fresh exact PO approval must accept retained17.09
      boundary; no supported rebind or reset. Remaining image/live gates in
      `docs/reports/2026-09-23-moderator-recurrence-candidate.md`.
      First activation failed on helper's millisecond release timestamp;
      exact-image regression accepts seconds. Validate full composed config
      inside image before recreation. Baseline2.4.41/3.2.0 healthy; retained
      Review store empty, no owner/socket; do not reprovision or replay.
      Comment9709 deletion completed once, never repeat. See
      `docs/reports/2026-09-17-review-activation-rollback.md`.
- [ ] PORN-RECOGNITION-EVAL: optional provider-only8synthetic inputs/max8calls,
      proposed ceilingUSD1. Offline helper9/9; dispatch marker/source/lease
      wrapper not frozen. Not executable, not approved, not_run; excludes
      Telegram/DB/sanctions and does not block the distinct Review release.
- [x] CROSS-ROLE-JUDGEMENT-1: Assistant2.4.39/exact2c72e01,
      lifecycle `production-verified`; main integration762c251 pushed.
      Native-revision judge owner, strict verdict/enforcement/answer fences,
     30-second idle ask cleanup and neutral invalid-judgement fallback live.
      Root1141passed/5fixture-skips, migration9/9,22helper checks;64deployed-file
      matches/footer, exact additive schema, health/restart0/config/Console passed.
      PO delegated remaining technical decisions; legacy natives/late edits
      quarantined. No a415 old-binary downgrade: tested STOP/preserve/forward
      repair. One recreation,0stop/rollback; lease/master closed06:59:32UTC.
      New paid/live Telegram acceptance remains not_run, not a claim of answer
      quality. `docs/reports/2026-09-16-assistant-2.4.39-deployment.md`.
- [ ] ASK-ROUTER-INVALID: owner reply to forceReply hint did reach BOTH bots,
      but Moderator rejected router result (`provider_safety_router_invalid`),
      so Assistant skipped before claim and cleanup never started. Read-only
      production trace04:17:46UTC passed; Privacy Mode hypothesis refuted for
      this incident. Partial mitigation deployed in2.4.39: one-owner protocol,
      operational fallback and cleanup. Follow-up2.4.41 repaired the contract;
      five real benign inputs passed, but native delivery/cleanup still needs
      an ordinary actor as above. Exact old contract subreason remains unknown;
      broad answer quality is not proven. No bypass/replay.
      See newest `docs/OWNER_FEEDBACK_LOG.md`.
- [ ] KNOWLEDGE-COVERAGE-COPY-1: reported2.4.38 answer exposes
      `missingDomains: content` and substitutes general course information.
      Read-only source diagnosis exists; actual live event/admission/retrieval
      cause not proven. Separate from2.4.39 deployment; no bundled body rewrite.
- [x] PORN-SPAM-1: exact runtimea41518f, lifecycle `production-verified`,
      semantic suspected solicitation under existing spam_or_scam/ban_purge.
      Root946passed/5skips, sourceguard/review passed; real recognition not_run.
      Source pushed; PO-approved runtime-only deployment04:32:23UTC,
      Assistant2.4.38;58-file hashes/repeated health/config/Console/HTTPS passed.
      One recreation/0rollback; lease/master closed04:34:43UTC.
      No private Review activation. See
      `docs/reports/2026-09-16-porn-spam-policy-deployment.md`.
- [x] CONSOLE-V32: exact source `f650fe8`, lifecycle `production-verified`,
      release23:12:03UTC. Last-five costs, known stages, mean denominator,
      3.1.1 labels and Help live. Root787passed/5skips/0failed, Console41/41;
      31source hashes,7headers/API/HTTPS/auth, actual stage arithmetic and
      independent ordinary Chrome passed. Last5=4 full estimates+1unknown;
      mean$0.0065898 over4. Runtime335a35a/config/drafts preserved.
      Lease/master closed23:13:28UTC; one recreation,0rollback.
      `docs/reports/2026-09-15-console-v32-deployment.md`.
- [x] MODERATOR-REVIEW-1: deployed in8a2b27f23September; real acceptance remains
      separately open above. Historical implementation checkpoints follow:
      PO-start verified; local synthetic private review/
      Admin verdict/pattern draft cycle chartered. Root owns shared entrypoints,
      storage integration and release; retention approved indefinite until
      manual removal, local erase/retained observation visibility contracts
      throughv5 accepted; recipient selected and verified, reviewer access pending,
      production collection/delivery disabled. Queue position1; requested
      mechanical owner Moderator, no active lease/SSH handoff. Root local source
      1829573/Console3.3.0 accepted:905passed/5fixture-skips, Console159/159,
      P2 fixes and disabled no-store mount independently checked. Lifecycle
      `pushed`, not deployed; see `docs/reports/2026-09-15-moderation-review-integration.md`.
      2026-09-17: оба PO решения получены: Guard независим от Review;
      erase удаляет linked IDs без future suppression. Локальный кандидат
      7d99ae0/Console3.4.0/Assistant2.4.40 pushed: capture/IPC/store/notification/
      decision/erase и covert-testimonial detector реализованы и проверены
      синтетически; root1427passed/5skips, migration9/9, Linux IPC/Compose passed.
      Local exact-image builds/source hashes/footer/imports passed после обхода
      зависшего credential helper отдельным временным anonymous Docker config.
      Нужны exact activation binding,
      reviewer access/limits/lease, deploy и live acceptance. См.
      `docs/proposals/2026-09-17-moderation-live-bridge-selected-v3.md` и
      `docs/MODERATION_REVIEW_ACTIVATION.md`.
- [x] CONSOLE-COST-V1 local implementation: integrated into3.2.0/f650fe8;
      production acceptance passed in CONSOLE-V32 above. No guessed usage/zero
      costs; worker backend preserved. Incorporates pushed3.1.1 copy fixes.
      Metadata-only diagnostic passed: latest5 all have answer/analyzer tokens,
      4 have exact no-router proof; live rate/eligibility/stage checks now passed.
      SSH closed, apps unchanged. Report:
      `docs/reports/2026-09-15-console-cost-metadata-diagnostic.md`.
      `docs/proposals/2026-09-15-console-cost-charter-v1.md`.
- [x] CONSOLE-V311: candidate `5e55101` lifecycle `pushed`, исправлены
      склонение и pricing-подпись;33Console tests passed. Для production
      standalone release superseded by CONSOLE-V32; separate deploy не нужен.
      Исправления включены в production3.2.0/f650fe8.
      `docs/reports/2026-09-15-console-v311-candidate.md`.
- [x] CONSOLE-V31: Console3.1.0 `eb0f7fe` production-verified, семь общих
      version/date/time headers + русская Помощь, лишние плашки убраны.
      Timestamp сравнен с реальным start (delta0.562637s); runtime/drafts сохранены.
      Lease/master закрыты; Chrome7/7 passed. Два copy-дефекта Analytics
      (склонение/English pricing ID) закрыты выпуском3.2.0. Receipt:
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

- **RUNTIME-NODE22 (2026-11-21).** Образ рантайма на `node:20.20.0-bookworm-slim`: Node 20 вне поддержки
  с 30.04.2026, последний патч 20.20.2; npm 10.8.2 не знает `min-release-age`. Перейти на Node 22 LTS,
  закрепить базовый образ по digest, npm ≥ 11.21; better-sqlite3 и onnxruntime-node — пересборка и
  проверка. Основание: `docs/npm-supply-chain-audit-2026-11-21.md`.
- **VPS-DOCKER-PRUNE (2026-11-21).** На news-vps 5 ГБ неактивных образов и 3,2 ГБ build cache; диск
  62% (19 ГБ свободно), не срочно. Чистить только свои образы aichattg, по подтверждению.
- **VPS-RAM note (2026-11-21, later).** Сессия News Digest перезапустила `news-server-fetcher` и
  остановила `news-substack-publisher` (не автостартует; включить: `docker start news-substack-publisher`).
  Доступно стало ~2,2 ГБ. Это чужой проект — только к сведению.
- **VPS-RAM (2026-11-21).** Память — узкое место общего VPS: 3,9 ГБ, доступно ~1 ГБ, без swap, 1 CPU.
  Любой новый тяжёлый процесс — с mem_limit контейнера и замером RSS.

- [ ] QUALITY-2: закрыть конкретные результаты живого прогона `049cc22`:
      NAV-01 (границы курсов/актуальность), NAV-07 (открытая лекция),
      CONCEPT-02 (Parent–Child coverage), ORG-03 (source URL не destination),
      ORG-04 (community navigation), ORG-02 (противоречие инструкций входа).
      Не менять источники/допуск production молча. Квитанции и диагнозы:
      `docs/reports/2026-09-15-assistant-live-baseline.md`.
- [ ] QUALITY-1: добавить отдельную content-grounding acceptance leg, которая
      проверяет ответ на верность выданным фрагментам знания. Нынешний judge
      проверяет поведение, но сознательно не оценивает фактическую опору.
- [ ] GATEKEEPER-1 (**на паузе с 15.11.2026, слово PO**): сценарии A
      (Tribute → Telegram) и B (сайт → email) не развиваются и не активируются;
      код и тесты `apps/gatekeeper/` не трогаются. Прежнее условие: Product
      Owner copy, две HTTPS-ссылки и placement в Operator Console; исторический
      import запрещён по умолчанию.
- [ ] JOINGATE-1: сценарий C — привратник по заявкам на вступление в открытую
      объединённую группу (`apps/join-gatekeeper/`, контракт
      `docs/proposals/2026-11-15-join-request-gatekeeper-v1.md`). Решение PO:
      какой бот (существующий бот Gatekeeper — A/B на паузе, вебхук свободен —
      или новый) и id объединённой группы.
- [ ] JOINGATE-2: PO утверждает тексты, вопросы, правила приёма и списки
      стоп-слов в `apps/join-gatekeeper/JOIN_SCENARIO.json` (сейчас черновик
      агента, `status: draft`); после этого — `ready`.
- [ ] JOINGATE-6 (17.11, PO через координатора aichattg-33): токены платных
      студентов (вход без анкеты, одноразовые, перевыпуск), режим «принят без
      права писать» (анкета по кнопке из закреплённого сообщения, удаление
      через N дней), пакетный разбор ~150 старых заявок по выгрузке
      (исполнение списков — только по подтверждению). Контракт v2:
      `docs/proposals/2026-11-17-join-request-gatekeeper-v2.md`.
- [ ] JOINGATE-3: activation candidate + lease: Compose-сервис и маршрут,
      env, регистрация webhook с `chat_join_request`, бот — админ группы
      с `can_invite_users` и `can_restrict_members` (v2 §4), включить
      «одобрение новых участников»; после включения проверить одобрение заявки,
      по которой бот не получал апдейт (v2 §5). Сначала
      `shadow` на несколько дней, разбор решений проверки аккаунтов, затем
      `enforce`. Проверить на staging, что после первого ответа человека бот
      пишет ему дольше 5-минутного окна (`inconclusive` до наблюдения).
- [ ] JOINGATE-7 (Later, при возобновлении A/B): решение PO 17.11 — один
      бот-привратник, несколько сценариев. Один webhook на токен, поэтому
      нужен тонкий диспетчер: `chat_join_request` и личка людей с активной
      заявкой/токеном → сценарий C (`apps/join-gatekeeper`), остальное → A/B
      (`apps/gatekeeper`). Пока A/B на паузе, webhook бота принадлежит C.
- [ ] JOINGATE-4 (Later): смысловая оценка ответов дешёвой моделью как
      дополнительный голос к детерминированным правилам — только после
      решения PO по политике платных вызовов.
- [ ] JOINGATE-5 (Later): вариант через Mini App (`query_id` +
      `sendChatJoinRequestWebApp` / `answerChatJoinRequestQuery`) — нужен
      размещённый HTTPS Mini App.

## Later

- [ ] **AI-TEACHERS — сертифицированные учителя ИИ (идея владельца 20.11.2026).** После этапа
  разбора владельцем: люди читают книгу, проходят курс, сдают сертификационный экзамен (платно,
  небольшая сумма) и получают право проверять и исправлять ответы вместо владельца. Разные мнения
  учителей обсуждаются во внутреннем чате (вроде Discord) до согласия; сообщество расширяет базу
  знаний; связано с рынком экспертов — учителям платят за то, что они учат систему отвечать лучше.
  Предложения агента: экзамен из случаев, решённых владельцем; вес учителя по совпадению с
  владельцем на скрытых контрольных случаях; несогласие при двух позициях книги → «показать обе»;
  исправления идут в петлю улучшений, а не прямо в ответ. Деньги и роли решает владелец.
  Документы: раздел 15 `~/Code/BestMentor_Plugin/docs/senior-service-concept.md`, раздел 11
  `docs/proposals/2026-11-19-senior-service-concept.md`. Не начинать без слова владельца.
- [ ] PLATFORMS-1 (решение владельца 18.11.2026): сейчас работаем только с
      Telegram. Discord — следующая платформа (модератор, ассистент, частично
      привратник; сначала общая прослойка вместо прямого чтения сообщений
      Telegram в рантайме, ~47 мест). Messenger и личка Instagram — потом,
      только ассистент один на один; Messenger как платный маркетинговый канал —
      резерв на время бюджетов. WhatsApp — возможно когда-нибудь. iMessage — нет.
      Исследование и матрица: `~/Code/operations/system/messaging-platforms/`.
      Не начинать без слова владельца.
- [ ] NEWSLETTER-1 (решение владельца 18.11.2026): рассылки в Telegram по
      этапам — (1) одна рассылка без меню и приложения, подписка по ссылке,
      анонс + «Читать», её продвигать; (2) вторая рассылка попроще; (3) когда
      рассылки двигаются — простое мини-приложение (витрина, подписка, мои
      подписки); (4) сложнее — кабинет со статистикой, частота, оценки, вопросы
      ассистенту, обсуждение в чате. Проект и телеметрия:
      `~/Code/operations/system/telegram-newsletters/README.md`. Открыто:
      какая рассылка первая и о чём. Не начинать без слова владельца.
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
