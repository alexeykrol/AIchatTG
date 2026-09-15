#!/usr/bin/env node
/** Closed-chat acceptance only. Default dry-run never reads secrets or connects.
 * --apply requires the integrator's separately approved paid-test scope, reviewed
 * registered route, and already-open SSH master. No connect/send/model retries.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET = Object.freeze({
  chatId: '-1002222077798', syntheticUserId: '8994494918',
  title: 'Чат1_Ментор_Test', assistantUsername: 'alexkrol_moderation_bot',
  host: 'news-vps', container: 'aichattg-aichattg-telegram-runtime-1',
  db: '/var/lib/aichattg/telegram-runtime/telegram-runtime.sqlite',
  envFile: '/Users/alexeykrolmini/Code/Synthetic_User/.env',
});
const fail = (code) => { throw new Error(code); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
const MESSAGE_ID = /^[1-9]\d{0,15}$/u;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function validatePlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.chatId !== TARGET.chatId
    || plan.syntheticUserId !== TARGET.syntheticUserId) fail('PLAN_TARGET_INVALID');
  if (!Number.isInteger(plan.maxQuestions) || plan.maxQuestions < 1 || plan.maxQuestions > 50
    || !Array.isArray(plan.cases) || !plan.cases.length || plan.cases.length > 50) fail('PLAN_LIMIT_INVALID');
  const ids = new Set();
  for (const c of plan.cases) {
    if (!c || !ID.test(c.id) || ids.has(c.id)) fail('PLAN_CASE_ID_INVALID');
    ids.add(c.id);
    if (!['ask', 'menu_reply'].includes(c.mode) || typeof c.question !== 'string'
      || !c.question.trim() || c.question.length > 3500 || /^\s*\//u.test(c.question)
      || !Array.isArray(c.expects) || !c.expects.length || !Array.isArray(c.sources)) fail('PLAN_CASE_INVALID');
    if (c.bareCommand !== undefined && (c.mode !== 'menu_reply'
      || !['/ask',`/ask@${TARGET.assistantUsername}`].includes(c.bareCommand))) fail('PLAN_MENU_COMMAND_INVALID');
  }
  return plan;
}

export function selectCases(plan, { limit, caseIds } = {}) {
  validatePlan(plan);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > plan.maxQuestions || limit > 50)) fail('LIMIT_INVALID');
  const requested = caseIds === undefined ? null : caseIds.split(',');
  if (requested && (!requested.length || new Set(requested).size !== requested.length
    || requested.some((id) => !plan.cases.some((c) => c.id === id)))) fail('CASE_FILTER_INVALID');
  const selected = plan.cases.filter((c) => !requested || requested.includes(c.id)).slice(0, limit ?? plan.maxQuestions);
  if (!selected.length) fail('EMPTY_SELECTION');
  return selected;
}

export function parseArgs(argv) {
  const opts = { apply: false };
  const names = { '--plan': 'plan', '--out': 'out', '--master': 'master', '--expected-sha': 'expectedSha', '--limit': 'limit', '--case-ids': 'caseIds' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (seen.has(a)) fail('DUPLICATE_ARGUMENT');
    seen.add(a);
    if (a === '--apply') opts.apply = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (names[a] && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[names[a]] = argv[++i];
    else fail('ARGUMENT_INVALID');
  }
  if (!opts.plan || (opts.apply && opts.dryRun)) fail('ARGUMENT_INVALID');
  if (opts.limit !== undefined) {
    if (!/^[1-9]\d*$/u.test(opts.limit)) fail('LIMIT_INVALID');
    opts.limit = Number(opts.limit);
  }
  if (opts.apply && (!opts.out || !isAbsolute(opts.master || '') || !/^[a-f0-9]{40}$/u.test(opts.expectedSha || ''))) fail('APPLY_REQUIREMENTS_MISSING');
  return opts;
}

export function parseSyntheticEnv(text) {
  const allowed = new Set(['SYNTHETIC_USER_BOT_TOKEN', 'SYNTHETIC_USER_TARGET_CHAT_ID']);
  const values = {};
  for (const raw of text.split(/\r?\n/u)) {
    const match = raw.trim().match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || !allowed.has(match[1])) continue;
    if (Object.hasOwn(values, match[1])) fail('SYNTHETIC_ENV_DUPLICATE');
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, '$2');
  }
  if (values.SYNTHETIC_USER_TARGET_CHAT_ID !== TARGET.chatId
    || !/^\d+:[A-Za-z0-9_-]+$/u.test(values.SYNTHETIC_USER_BOT_TOKEN || '')) fail('SYNTHETIC_ENV_INVALID');
  if (values.SYNTHETIC_USER_BOT_TOKEN.split(':')[0] !== TARGET.syntheticUserId) fail('SYNTHETIC_ENV_ID_MISMATCH');
  return { token: values.SYNTHETIC_USER_BOT_TOKEN, chatId: values.SYNTHETIC_USER_TARGET_CHAT_ID };
}

export function validateTelegramIdentity(me, chat) {
  if (String(me?.id) !== TARGET.syntheticUserId || me?.is_bot !== true) fail('SYNTHETIC_IDENTITY_MISMATCH');
  if (String(chat?.id) !== TARGET.chatId || chat?.type !== 'supergroup'
    || chat?.title !== TARGET.title || chat?.username || (chat?.active_usernames || []).length) fail('CLOSED_CHAT_IDENTITY_MISMATCH');
}

export function sshArgs(master, command) {
  if (!isAbsolute(master) || /[\r\n\0]/u.test(master)) fail('MASTER_PATH_INVALID');
  return ['-S', master, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no', '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'ConnectionAttempts=1', '-o', 'ConnectTimeout=5', '-o', 'ProxyCommand=false',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', TARGET.host, command];
}

function executeRemote(master, command, input = '', timeoutMs = 30_000) {
  try { if (!lstatSync(master).isSocket()) fail('TRANSPORT_UNAVAILABLE'); }
  catch { fail('TRANSPORT_UNAVAILABLE'); }
  return new Promise((done, reject) => {
    const child = execFile('/usr/bin/ssh', sshArgs(master, command), {
      timeout: Math.max(1,Math.min(30_000,timeoutMs)), killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
    }, (error, stdout) => {
      // Never echo stderr, command internals, provider messages or credentials.
      if (error) { reject(new Error(error.code === 255 || error.killed ? 'TRANSPORT_UNAVAILABLE' : 'REMOTE_APPLICATION_ERROR')); return; }
      try { done(JSON.parse(stdout)); } catch { reject(new Error('REMOTE_RESULT_INVALID')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Fixed target, no database imports from another project, no writable open. */
export function remoteScript(request) {
  if (!['preflight', 'reconcile'].includes(request.operation)) fail('REMOTE_OPERATION_INVALID');
  if (request.operation === 'reconcile' && !MESSAGE_ID.test(String(request.messageId))) fail('MESSAGE_ID_INVALID');
  return `
const Database = require('better-sqlite3');
const { pathToFileURL } = require('node:url');
const req = ${JSON.stringify(request)};
const target = ${JSON.stringify({ chatId: TARGET.chatId, syntheticUserId: TARGET.syntheticUserId, db: TARGET.db })};
(async () => {
const db = new Database(target.db, {readonly:true,fileMustExist:true});
try {
if(req.operation === 'preflight') {
 const {loadRuntimeConfig} = await import(pathToFileURL(process.cwd()+'/src/config.mjs'));
 const c = loadRuntimeConfig(process.env);
 const at = Math.floor(Date.now()/1000);
 const quota = db.prepare("SELECT COUNT(*) AS used, MAX(created_at) AS lastAt FROM runtime_assistant_request_reservations WHERE chat_id=? AND user_id=? AND status IN ('reserved','completed','uncertain') AND created_at > ?").get(target.chatId,target.syntheticUserId,at-86400);
 const tuple = x => x ? {model:x.model,reasoningEffort:x.reasoningEffort,maxOutputTokens:x.maxOutputTokens} : null;
 console.log(JSON.stringify({at,ingress:c.ingressEnabled,synthetic:c.syntheticTestingEnabled,knowledge:c.assistantKnowledgeEnabled,provider:c.provider.enabled,
   assistantChatAllowed:c.assistant.chatIds.includes(target.chatId),moderatorChatAllowed:c.moderator.chatIds.includes(target.chatId),
   syntheticAllowed:c.assistant.syntheticBotIds.includes(target.syntheticUserId),exempt:c.assistant.exemptBotIds.includes(target.syntheticUserId),
   ownBot:c.assistant.botToken.split(':')[0]===target.syntheticUserId,assistantUsername:c.assistant.botUsername,
   databasePath:c.databasePath,analyzerMode:c.analyzer.mode,analyzerChatAllowed:c.analyzer.chatIds.includes(target.chatId),
   cooldownSec:c.assistantCooldownSec,dailyCap:c.assistantSyntheticDailyPerUser>0?c.assistantSyntheticDailyPerUser:c.assistantDailyPerUser,quota,
   models:{answer:tuple(c.provider.modelTuples?.assistantAnswer),router:tuple(c.provider.modelTuples?.assistantRouter)},
   analyzerModel:process.env.TELEGRAM_RUNTIME_ANALYZER_MODEL||null}));
} else {
 const revision = target.chatId+':'+req.messageId;
 const receipts = db.prepare('SELECT receipt_id,bot_role,update_id,revision_identity,status,error_code,received_at FROM runtime_inbound_update_receipts WHERE bot_role=? AND revision_identity=? LIMIT 2').all('assistant',revision);
 if(receipts.length>1) throw Error('AMBIGUOUS_IDENTITY');
 const receipt = receipts[0]||null;
 const event = receipt ? db.prepare('SELECT event_id,bot_role,update_id,status,result_json,created_at,completed_at FROM runtime_inbound_events WHERE event_id=?').get(receipt.receipt_id)||null : null;
 const claim = db.prepare('SELECT chat_id,message_id,status,outcome FROM runtime_assistant_question_claims WHERE chat_id=? AND message_id=?').get(target.chatId,String(req.messageId))||null;
 const answer = event ? db.prepare('SELECT event_id,chat_id,user_id,question,answer,route_action,route_source_id,knowledge_source_id,served_unit_ids,model_id,input_tokens,output_tokens,total_tokens,delivery,created_at FROM runtime_assistant_answer_records WHERE event_id=? AND chat_id=? AND user_id=?').get(event.event_id,target.chatId,target.syntheticUserId)||null : null;
 const analyzer = event ? db.prepare('SELECT event_id,chat_id,user_id,status,topics,level,intent,route_action,route_source_id,model_id,input_tokens,output_tokens,total_tokens,route_model_id,route_input_tokens,route_output_tokens,route_total_tokens,created_at FROM runtime_assistant_analyzer_observations WHERE event_id=? AND chat_id=? AND user_id=?').get(event.event_id,target.chatId,target.syntheticUserId)||null : null;
 console.log(JSON.stringify({receipt,event:event?{...event,result:JSON.parse(event.result_json||'null'),result_json:undefined}:null,claim,answer,analyzer}));
}
} finally {db.close();}
})().catch(()=>{console.error('READONLY_QUERY_FAILED');process.exitCode=2;});
`;
}

function makeRemote(master) {
  return {
    inspect: () => executeRemote(master, `timeout --signal=TERM --kill-after=5s 25s docker inspect --format '{{json .Config.Labels}}' ${TARGET.container}`),
    query: (request, timeoutMs) => executeRemote(master, `timeout --signal=TERM --kill-after=5s 25s docker exec -i ${TARGET.container} node -`, remoteScript(request),timeoutMs),
  };
}

function makeTelegram(token) {
  return async (method, params = {}) => {
    if (!['getMe', 'getChat', 'sendMessage'].includes(method)) fail('TELEGRAM_METHOD_FORBIDDEN');
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
    const sending = method === 'sendMessage';
    if (!sending) Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,String(v)));
    let response;
    try {
      response = await fetch(url, { method: sending ? 'POST' : 'GET',
        ...(sending ? { headers: {'content-type':'application/json'}, body: JSON.stringify(params) } : {}),
        signal: AbortSignal.timeout(20_000), redirect: 'error' });
    } catch { fail(sending ? 'TELEGRAM_SEND_AMBIGUOUS' : 'TELEGRAM_PREFLIGHT_TRANSPORT'); }
    let body;
    try { body = await response.json(); } catch { fail(sending ? 'TELEGRAM_SEND_AMBIGUOUS' : 'TELEGRAM_RESULT_INVALID'); }
    if (!response.ok || body.ok !== true) fail(sending ? 'TELEGRAM_SEND_FAILED_OR_UNCERTAIN' : 'TELEGRAM_PREFLIGHT_REFUSED');
    return body.result;
  };
}

export function validateRemotePreflight(snapshot, count) {
  if (snapshot.ingress !== true || snapshot.synthetic !== true || snapshot.knowledge !== true || snapshot.provider !== true
    || !snapshot.assistantChatAllowed || !snapshot.moderatorChatAllowed || !snapshot.syntheticAllowed
    || snapshot.exempt || snapshot.ownBot || snapshot.databasePath !== TARGET.db
    || snapshot.assistantUsername !== TARGET.assistantUsername || !snapshot.analyzerChatAllowed
    || !['observe','dispatch'].includes(snapshot.analyzerMode)) fail('RUNTIME_GATE_MISMATCH');
  if (!Number.isInteger(snapshot.cooldownSec) || snapshot.cooldownSec < 0 || snapshot.cooldownSec > 120
    || !Number.isInteger(snapshot.dailyCap) || snapshot.dailyCap < 0
    || !Number.isInteger(snapshot.quota?.used) || snapshot.quota.used < 0
    || !Number.isInteger(snapshot.at)) fail('RUNTIME_LIMIT_INVALID');
  if (snapshot.dailyCap > 0 && snapshot.quota.used + count > snapshot.dailyCap) fail('SYNTHETIC_QUOTA_INSUFFICIENT');
}

export function validateReconciliation(data, messageId, since, { menu = false } = {}) {
  if (!data.receipt) return false;
  const r = data.receipt, e = data.event;
  if (r.bot_role !== 'assistant' || r.revision_identity !== `${TARGET.chatId}:${messageId}`
    || r.receipt_id !== `assistant:${r.update_id}` || r.received_at < since - 10) fail('RECEIPT_IDENTITY_MISMATCH');
  if (r.error_code || ['skipped','uncertain'].includes(r.status)) fail('INBOUND_TERMINAL_FAILURE');
  if (!e) return false;
  if (e.event_id !== r.receipt_id || e.bot_role !== 'assistant' || e.update_id !== r.update_id) fail('EVENT_IDENTITY_MISMATCH');
  if (['error','skipped'].includes(e.status)) fail('ASSISTANT_APPLICATION_FAILURE');
  if (r.status !== 'completed' || e.status !== 'completed') return false;
  if (!data.claim || data.claim.chat_id !== TARGET.chatId || data.claim.message_id !== String(messageId)
    || data.claim.status !== 'completed' || data.claim.outcome !== 'answered'
    || e.result?.eventId !== e.event_id || e.result?.kind !== 'answered' || e.result?.receipt?.ok !== true
    || !MESSAGE_ID.test(e.result.receipt.messageId || '')) fail('ANSWER_RECEIPT_INVALID');
  if (menu) {
    const p = e.result.askPrompt;
    if (e.result.command !== 'ask_empty' || e.result.route !== 'command:ask_empty'
      || p?.chatId !== TARGET.chatId || p?.userId !== TARGET.syntheticUserId
      || p?.commandMessageId !== String(messageId) || p?.promptMessageId !== e.result.receipt.messageId) fail('MENU_HINT_IDENTITY_MISMATCH');
  } else {
    const a = data.answer;
    if (!a || a.event_id !== e.event_id || a.chat_id !== TARGET.chatId || a.user_id !== TARGET.syntheticUserId
      || typeof a.answer !== 'string' || !a.answer.trim() || a.delivery !== 'ok') fail('ANSWER_RECORD_INVALID_OR_DEGRADED');
    if (data.analyzer && (data.analyzer.event_id !== e.event_id || data.analyzer.chat_id !== TARGET.chatId
      || data.analyzer.user_id !== TARGET.syntheticUserId || data.analyzer.status !== 'ok')) fail('ANALYZER_RECORD_INVALID');
  }
  return true;
}

export async function runAcceptance(plan, cases, expectedSha, deps) {
  const { remote, telegram, append, now = Date.now, wait = sleep } = deps;
  const start = Math.floor(now()/1000);
  const boundedWait = async (ms) => { while(ms>0) {const part=Math.min(ms,30_000);await wait(part);ms-=part;} };
  const me = await telegram('getMe');
  const chat = await telegram('getChat', { chat_id: TARGET.chatId });
  validateTelegramIdentity(me, chat);
  append({type:'identity',at:start,chatId:TARGET.chatId,syntheticUserId:TARGET.syntheticUserId,closed:true});
  const poll = async (messageId, menu = false) => {
    const deadline = now()+120_000;
    while (now() < deadline) {
      const data = await remote.query({operation:'reconcile',messageId:String(messageId)},deadline-now());
      if (now()>=deadline) fail('ANSWER_RECONCILIATION_TIMEOUT');
      if (validateReconciliation(data,String(messageId),start,{menu})) return data;
      if (now()+5_000 >= deadline) break;
      await wait(5_000);
    }
    fail('ANSWER_RECONCILIATION_TIMEOUT');
  };
  const send = async (c, text, replyId = null, stage = 'question') => {
    append({type:'send_intent',caseId:c.id,stage,chatId:TARGET.chatId,at:Math.floor(now()/1000)});
    const sent = await telegram('sendMessage', {chat_id:TARGET.chatId,text,
      ...(replyId ? {reply_parameters:{message_id:Number(replyId),allow_sending_without_reply:false}} : {})});
    // Keep no raw Telegram result: it can contain profile/user/chat payloads.
    if (!MESSAGE_ID.test(String(sent?.message_id)) || String(sent?.chat?.id) !== TARGET.chatId
      || String(sent?.from?.id) !== TARGET.syntheticUserId || sent?.from?.is_bot !== true) fail('SEND_RECEIPT_IDENTITY_MISMATCH');
    const receipt = {type:'sent',caseId:c.id,stage,chatId:TARGET.chatId,userId:TARGET.syntheticUserId,
      messageId:String(sent.message_id),at:Math.floor(now()/1000),question:text};
    append(receipt);
    return receipt;
  };
  let completed = 0;
  for (const c of cases) {
    const labels = await remote.inspect();
    if (labels?.['org.opencontainers.image.revision'] !== expectedSha) fail('DEPLOYED_SHA_MISMATCH');
    const cfg = await remote.query({operation:'preflight'});
    validateRemotePreflight(cfg,cases.length-completed);
    append({type:'runtime_preflight',caseId:c.id,expectedSha,...cfg});
    const cooldownMs = (cfg.cooldownSec+2)*1000;
    const remaining = cfg.quota.lastAt ? cfg.quota.lastAt*1000+cooldownMs-now() : 0;
    if (remaining>0) await boundedWait(remaining);
    let menu;
    if (c.mode === 'menu_reply') {
      const bare = await send(c,c.bareCommand||`/ask@${TARGET.assistantUsername}`,null,'menu');
      menu = await poll(bare.messageId,true);
      append({type:'menu_receipt',caseId:c.id,...menu});
    }
    const replyId = menu?.event?.result?.askPrompt?.promptMessageId;
    const sent = await send(c,replyId ? c.question : `/ask@${TARGET.assistantUsername} ${c.question}`,replyId);
    const answer = await poll(sent.messageId);
    append({type:'answer',caseId:c.id,messageId:sent.messageId,...answer});
    if (menu) {
      const after = await remote.query({operation:'reconcile',messageId:menu.claim.message_id});
      validateReconciliation(after,menu.claim.message_id,start,{menu:true});
      const cleanup = after.event?.result?.askPromptCleanup;
      append({type:'cleanup',caseId:c.id,commandEventId:menu.event.event_id,cleanup:cleanup||null});
      if (cleanup?.state !== 'finished' || cleanup?.answerEventId !== answer.event.event_id
        || cleanup?.prompt?.state !== 'deleted' || cleanup?.command?.state !== 'deleted') fail('MENU_CLEANUP_NOT_VERIFIED');
    }
    completed++;
    append({type:'case_summary',caseId:c.id,deliveryStatus:'passed',contentStatus:'not_run',eventId:answer.event.event_id,
      messageId:sent.messageId,route:answer.answer.route_action,model:answer.answer.model_id,
      inputTokens:answer.answer.input_tokens,outputTokens:answer.answer.output_tokens});
    if (completed<cases.length) await boundedWait(cooldownMs);
  }
  return {status:'delivery_verified',deliveryStatus:'passed',contentStatus:'not_run',completed,questions:cases.length,chatId:plan.chatId};
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const planBytes = readFileSync(resolve(opts.plan));
  const plan = validatePlan(JSON.parse(planBytes));
  const cases = selectCases(plan,opts);
  const manifest = {schemaVersion:1,mode:opts.apply?'apply':'dry-run',chatId:plan.chatId,syntheticUserId:plan.syntheticUserId,
    planSha256:createHash('sha256').update(planBytes).digest('hex'),caseIds:cases.map(c=>c.id),questions:cases.length,
    telegramSends:cases.length+cases.filter(c=>c.mode==='menu_reply').length,expectedSha:opts.expectedSha||null};
  if (!opts.apply) { process.stdout.write(`${JSON.stringify(manifest,null,2)}\n`); return manifest; }
  // mkdir without recursive or existing-dir fallback: never overwrite a run.
  const out = resolve(opts.out);
  mkdirSync(out,{mode:0o700});
  writeFileSync(join(out,'manifest.json'),JSON.stringify({...manifest,cases},null,2)+'\n',{flag:'wx',mode:0o600});
  const append = row => appendFileSync(join(out,'receipts.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});
  try {
    const {token} = parseSyntheticEnv(readFileSync(TARGET.envFile,'utf8'));
    const result = await runAcceptance(plan,cases,opts.expectedSha,{remote:makeRemote(opts.master),telegram:makeTelegram(token),
      append:row=>{append(row);if(row.type==='case_summary') process.stdout.write(JSON.stringify(row)+'\n');}});
    writeFileSync(join(out,'summary.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    process.stdout.write(JSON.stringify(result)+'\n');
    return result;
  } catch(error) {
    // Only our fixed codes are public. FS/HTTP/child-process messages can leak.
    const code = /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message||'') ? error.message : 'LOCAL_OR_UNCLASSIFIED_ERROR';
    append({type:'stopped',status:'failed',code,at:new Date().toISOString(),retry:false});
    throw new Error(code);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{const code=/^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message||'')?error.message:'LOCAL_OR_UNCLASSIFIED_ERROR';process.stderr.write(code+'\n');process.exitCode=1;});
}
