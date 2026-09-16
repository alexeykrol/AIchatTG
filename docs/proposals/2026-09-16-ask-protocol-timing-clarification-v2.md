# Ask protocol — timing clarification v2

This addendum clarifies the timing acceptance criteria in
[ask-protocol-v1](2026-09-16-ask-protocol-charter-v1.md), preserving that charter
as the original reservation. It does not broaden file ownership or release
authority.

The Assistant task re-read and relayed the owner's exact instruction:
«если вопрос не пришел в течении 30 секунд, то надо удалять и вызов бота и
его промпт»; «При этом, может возникнуть ситуация, когда 30 секунд прошли,
но мы полчили вопрос в ответе - тогда надо ответить.»

Therefore the30-second deadline is **idle waiting for a question**, measured
from successfully delivered hint. A correctly bound authenticated nonempty
reply atomically marks question_received before model work and cancels idle
expiry. Normal completed-answer cleanup removes the proven service pair.
If expiry wins, it may remove only that pair; a late reply remains routable
and answerable subject to normal safety. Answer and expiry cannot duplicate
delete calls or delete substantive Q/A. Empty/foreign/forged replies do not
cancel another person's timer. Restart must preserve the winning state.

Visible failure copy remains a candidate, not PO-approved published copy.
Root recommends: «Сейчас не удалось обработать вопрос. Попробуйте, пожалуйста,
позже.» It reports an operational failure without falsely blaming knowledge
review or implying the user's question was unsafe. Preserve once-only delivery,
code-owned footer and exclusion from substantive dialogue memory.

Rollback remains a release gate: old a41518f does not understand new protocol
ownership. Additive schema is not rollback proof. Require a tested controlled
stop/drain/quarantine and explicit treatment of late webhooks; no automatic
binary downgrade with live protocol jobs.
