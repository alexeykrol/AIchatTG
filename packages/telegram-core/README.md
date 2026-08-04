# Telegram product core — extraction seam

This package will hold the stable contracts shared by Moderator, Assistant and
Gatekeeper: identity, chat and membership state, eligibility and moderation
dispositions, idempotent event claims, delivery receipts and escalation state.

No bot adapter may write another bot's internal tables directly. The concrete
interfaces will be introduced with the Moderator/Assistant runtime extraction;
this placeholder prevents shared concerns from being copied into the Digest or
duplicated across the three bots.
