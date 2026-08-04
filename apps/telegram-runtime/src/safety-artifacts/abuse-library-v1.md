# Telegram Abuse Library v1

This library covers targeted interpersonal abuse that is not a threat. Threats,
incitement, spam/scam, system attacks, and attempts to obtain protected data are
classified by the threat library instead. The model reports meaning and, in the
second-stage classifier, `weak` or `strong` severity only. It never chooses a
moderation action.

## Closed abuse types

- `targeted_insult` — a direct degrading label, slur, contemptuous personal
  attack, or humiliating characterization aimed at an identifiable target.
- `harassment` — targeted pestering, hostile pursuit, repeated antagonism, or a
  pattern intended to distress or drive out an identifiable target.
- `hate_or_dehumanization` — identity-based degradation or language that treats
  a protected group or member as inferior, subhuman, contaminating, or
  undeserving of equal dignity, without threatening or inciting harm.
- `sexual_harassment` — unwanted sexualized degradation, propositions,
  objectification, or explicit sexual remarks directed at a target.
- `targeted_malicious_accusation` — a knowingly or recklessly asserted severe
  accusation about an identifiable target, used primarily to humiliate,
  discredit, or mobilize hostility rather than make a good-faith factual claim.
- `targeted_provocation` — a directed taunt, bait, contemptuous challenge, or
  personalized sneer whose purpose is to provoke or demean.
- `warning_dispute` — after a prior moderation warning, the same participant
  argues about, refuses, mocks, or attempts to relitigate that warning. This
  type is impossible without code-supplied prior-warning context.

## Weak abuse

Classify `weak` when the message contains targeted misconduct but its semantic
severity is limited, for example:

- an isolated low-grade insult, sneer, or personalized put-down;
- isolated targeted pestering or hostile pursuit that has not yet become a
  sustained campaign;
- a directed sarcastic jab or bait intended to provoke;
- a rude personal dismissal that crosses from criticism of ideas to degradation
  of a person but is not severe, dehumanizing, sexual, or sustained;
- an isolated unwanted sexual proposition or low-grade sexual objectification
  without coercion, explicit humiliation, or a sustained pattern;
- `warning_dispute` supported by prior-warning context, unless the same message
  independently meets a strong criterion.

## Strong abuse

Classify `strong` only for clearly severe targeted abuse, for example:

- dehumanizing or severe identity-based degradation;
- severe sexual harassment or explicit sexual humiliation;
- sustained or repeated harassment evident in the supplied message/context;
- an extreme degrading slur or campaign-like pile-on against a target;
- a severe malicious accusation stated as fact primarily to humiliate or
  mobilize hostility.

Do not upgrade ordinary rudeness, one mild insult, a warning dispute, or sharp
criticism to `strong` merely because the tone is unpleasant.

## Hard negatives

- Legitimate criticism of the author, assistant, a product, an idea, conduct, or
  a public claim — including blunt, unfavorable, or inconvenient criticism — is
  not abuse unless it attacks an identifiable person rather than the substance.
- Disagreement, fact-checking, requests for evidence, allegations made as a
  good-faith question, and statements such as "you are wrong" are not abuse by
  themselves.
- Profanity expressing emotion without a target, self-deprecation, consensual
  banter, and jokes without a victim are not abuse.
- Quoting, reporting, condemning, translating, or academically discussing an
  insult, slur, abusive message, or threat is not abuse unless the current
  speaker adopts or redirects it at a target.
- Fictional dialogue, historical material, moderation examples, and security
  examples are not abuse without a real current target.
- A discussion of moderation rules or appeals in general is not
  `warning_dispute`. That type requires code-supplied evidence of this user's
  prior warning.
- Threats and incitement are not abuse types. Report them under the threat
  library even when they are also insulting.

## Evidence

Evidence must be one to three short, verbatim spans from the current message.
Never invent, translate, normalize, or paraphrase evidence.
