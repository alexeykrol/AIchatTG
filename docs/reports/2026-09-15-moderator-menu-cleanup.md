# Moderator test-chat command cleanup — 2026-09-15 UTC

Lifecycle: `production-verified`. One Telegram command-registration change;
no application deployment. Lease consumed and closed at 21:46:03 UTC.

## Approval and exact boundary

In task «Модератор» (`019fd023-a949-7961-87cd-693bcb893e2c`), the owner
explicitly requested «Если нет, то все сделай, задеплой, контроль, чтобы я тебя
не подгонял.» Message `01a0a700-6469-7ab3-aad7-064d22650452` was re-read in
its context: only the parasite Moderator menu in the test chat. This does not
authorize the separate Assistant menu localization candidate or a new release.
The root integrator performed the change; the requesting task reviewed evidence.

Lease `moderator-test-chat-command-20260915-2139`, expiry 22:00 UTC, allowed
one conditional `deleteMyCommands` on Moderator `@ai_akrolmoder_bot`,
bot ID `8794171027`, with this exact body:

```json
{"scope":{"type":"chat","chat_id":"-1002222077798"},"language_code":""}
```

The original v1 Markdown/JSON proposal in the Moderator worktree was not
rewritten. Its hashes are respectively
`947ddbf75c1411d0a6179b6288358fa75492181c2c6251d0d79aebc0f8b4d9e1` and
`eb602b91ec0d4cd660f896c47ecb823a7dfce28c32118214e11ce3e99321eaa5`.
The new approval and separate lease supersede its historical unapproved state.

## Execution and verification

- `passed`: eight offline Node 20.20.0 tests cover exact deletion, empty no-op,
  target/neighbor/identity drift, ambiguous API result, postflight drift and
  expiry. No test calls Telegram.
- `passed`: live execution 21:42:26.170–21:42:34.427 UTC. Before and after each
  read `getMe` and 18 unique command cells: default, all-private, all-group,
  all-chat-administrators, target-chat and target-chat-administrators, each with
  language empty/ru/en. Both identities matched the exact Moderator bot.
- `passed`: before, only target cell 12 contained
  `ask` / `вопрос ассистенту`; the other 17 were empty. After, all 18 were empty.
- `passed`: exactly one `deleteMyCommands`, result `true` at 21:42:30.583 UTC;
  38 read calls, changed cells `[12]`, no retry or rollback call.
- `passed`: the Moderator task independently checked the complete local JSONL
  receipt, both matrices, exact identity/body, counts, hashes and lease timing.
- `passed`: container snapshots before and after are byte-identical. Runtime
  `335a35ad344706062a292581db4d27c5776c4302` and Console
  `82cb8c60f7ad4dbd773bf76b194794ee313165fe` retain their image IDs, container
  IDs, start times, env/mount/route digests, healthy state and zero restarts.
- `passed`: the only SSH master was closed and its socket absence checked.
- `not_run`: Telegram client refresh, unknown languages and unknown
  member-specific command scopes. These were not represented as verified.

No rebuild, image/config/webhook/secret/migration change, message send or
message deletion, paid model call, Docker log read or Assistant API operation
occurred. Removing a menu entry does not disable manually typed commands or
change runtime routing. The earlier command-plus-hint cleanup acceptance gap
remains separate; this menu-only operation does not close it.

## Retained evidence

Token-free local artifacts are ignored under
`output/moderator-command-cleanup-20260915/`:

| Artifact | SHA-256 |
| --- | --- |
| `lease.json` | `8d8d198e5029cd1804ab0683b0c630bda3c167a4038f005c323c7d0713c6cdc1` |
| `operation.jsonl` (full before/after matrices and API result) | `04f945ba1e3b799d91507b9f8e3c8c70662461b61d24862a90f004fe139bad7c` |
| `apps-before.json` and `apps-after.json` | `e9c81bda4ab3b6154057f730b84beac921a0c1d6374cfd2b0b0f75d02ee130d7` |
| `cleanup.mjs` | `f05ab39ca7265c3d7183a6bf2fd337a138232771287fc7cb6fdeeedfd7be4f0a` |
| `test.mjs` | `fddf27858f4c7c1ab173e4d8d4e36e036d27a8b645e72abf7e13f9ae0e4d1e13` |

`closure.json` records consumed authority, matching app hashes and closed SSH.
There is no remaining permission to repeat this mutation. The original exact
restore recipe remains in the proposal, but automatic rollback is disabled;
restoring an unwanted entry requires fresh explicit approval and a new check.
