import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { main, parseArgs, parseSyntheticEnv, remoteScript, runAcceptance, selectCases,
  sshArgs, TARGET, validatePlan, validateReconciliation, validateRemotePreflight,
  validateTelegramIdentity } from '../assistant-acceptance-live.mjs';

const SHA='a'.repeat(40);
const one={id:'Q01',question:'Что такое MCP?',mode:'ask',expects:['source-grounded answer'],sources:[]};
const plan=(cases=[one])=>({schemaVersion:1,chatId:TARGET.chatId,syntheticUserId:TARGET.syntheticUserId,maxQuestions:30,cases});
const me={id:Number(TARGET.syntheticUserId),is_bot:true};
const chat={id:Number(TARGET.chatId),type:'supergroup',title:TARGET.title};
function config() {return {at:1000,ingress:true,synthetic:true,knowledge:true,provider:true,
  assistantChatAllowed:true,moderatorChatAllowed:true,syntheticAllowed:true,exempt:false,ownBot:false,
  assistantUsername:TARGET.assistantUsername,databasePath:TARGET.db,analyzerMode:'dispatch',analyzerChatAllowed:true,
  cooldownSec:20,dailyCap:200,quota:{used:6,lastAt:null}};}
function reconciled(messageId='123',menu=false) {
  const eventId=`assistant:${Number(messageId)+1000}`;
  return {
    receipt:{receipt_id:eventId,bot_role:'assistant',update_id:Number(messageId)+1000,
      revision_identity:`${TARGET.chatId}:${messageId}`,status:'completed',error_code:null,received_at:1000},
    event:{event_id:eventId,bot_role:'assistant',update_id:Number(messageId)+1000,status:'completed',
      result:{eventId,kind:'answered',receipt:{ok:true,messageId:'987'},
        ...(menu?{command:'ask_empty',route:'command:ask_empty',askPrompt:{chatId:TARGET.chatId,userId:TARGET.syntheticUserId,
          commandMessageId:String(messageId),promptMessageId:'987'}}:{})}},
    claim:{chat_id:TARGET.chatId,message_id:String(messageId),status:'completed',outcome:'answered'},
    answer:menu?null:{event_id:eventId,chat_id:TARGET.chatId,user_id:TARGET.syntheticUserId,question:one.question,
      answer:'MCP — протокол.',delivery:'ok',route_action:'teach',model_id:'test-model',input_tokens:12,output_tokens:4,total_tokens:16},
    analyzer:null,
  };
}
function harness({pending=false,sendFailure=false,menu=false}={}) {
  let clock=1000_000;
  let id=122;
  const calls=[],rows=[];
  return {calls,rows,now:()=>clock,wait:async ms=>{assert.ok(ms<=30_000);clock+=ms;},append:r=>rows.push(r),
    telegram:async(method,params)=>{
      calls.push({method,params});
      if(method==='getMe')return me;
      if(method==='getChat')return chat;
      if(sendFailure)throw Error('TELEGRAM_SEND_AMBIGUOUS');
      return {message_id:++id,from:me,chat};
    },remote:{
      inspect:async()=>({'org.opencontainers.image.revision':SHA}),
      query:async(req,timeout)=>{
        calls.push({remote:req,timeout});
        if(req.operation==='preflight')return {...config(),at:Math.floor(clock/1000)};
        if(pending)return {receipt:null};
        const result=reconciled(req.messageId,menu&&req.messageId==='123');
        if(menu&&req.messageId==='123'&&id>123)result.event.result.askPromptCleanup={state:'finished',answerEventId:'assistant:1124',
          prompt:{state:'deleted'},command:{state:'deleted'}};
        result.receipt.received_at=Math.floor(clock/1000);
        return result;
      },
    }};
}

test('plan locks target, question budget, unique ids and predeclared expectations',()=>{
  assert.equal(validatePlan(plan()).chatId,TARGET.chatId);
  for(const p of [{...plan(),chatId:'-1001'},{...plan(),syntheticUserId:'1'},{...plan(),maxQuestions:51},
    plan([one,one]),plan([{...one,expects:[]}]),plan([{...one,mode:'arbitrary'}]),plan([{...one,question:'/ask hidden'}])]) {
    assert.throws(()=>validatePlan(p));
  }
});
test('case filter rejects misspellings/duplicates and respects plan order and limits',()=>{
  const p=plan([one,{...one,id:'Q02'},{...one,id:'Q03'}]);
  assert.deepEqual(selectCases(p,{caseIds:'Q03,Q01'}).map(c=>c.id),['Q01','Q03']);
  assert.deepEqual(selectCases(p,{limit:2}).map(c=>c.id),['Q01','Q02']);
  for(const opt of [{limit:31},{limit:0},{limit:1.5},{caseIds:'Q00'},{caseIds:'Q01,Q01'},{caseIds:''}])assert.throws(()=>selectCases(p,opt));
});
test('CLI defaults dry-run and apply requires exact SHA existing-master path and output',()=>{
  assert.equal(parseArgs(['--plan','x']).apply,false);
  assert.equal(parseArgs(['--plan','x','--apply','--out','x','--master','/tmp/socket','--expected-sha',SHA]).apply,true);
  for(const argv of [['--plan','x','--apply'],['--plan','x','--apply','--dry-run'],['--plan','x','--limit','1junk'],
    ['--plan','x','--limit','1','--limit','2'],['--plan','x','--wat']])assert.throws(()=>parseArgs(argv));
});
test('env parsing admits only two exact keys with no shell evaluation',()=>{
  const text=`IGNORED_SECRET=do-not-return\nSYNTHETIC_USER_BOT_TOKEN='${TARGET.syntheticUserId}:fixture_secret'\nSYNTHETIC_USER_TARGET_CHAT_ID=${TARGET.chatId}\n`;
  assert.deepEqual(parseSyntheticEnv(text),{token:`${TARGET.syntheticUserId}:fixture_secret`,chatId:TARGET.chatId});
  assert.throws(()=>parseSyntheticEnv(text+`SYNTHETIC_USER_TARGET_CHAT_ID=${TARGET.chatId}\n`),/DUPLICATE/);
  assert.throws(()=>parseSyntheticEnv(text.replace(TARGET.chatId,'-1001')),/INVALID/);
  assert.throws(()=>parseSyntheticEnv(text.replace('fixture_secret','$(evil)')),/INVALID/);
});
test('Telegram preflight locks bot identity and nonpublic exact closed supergroup',()=>{
  validateTelegramIdentity(me,chat);
  assert.throws(()=>validateTelegramIdentity({...me,is_bot:false},chat));
  assert.throws(()=>validateTelegramIdentity(me,{...chat,username:'public'}));
  assert.throws(()=>validateTelegramIdentity(me,{...chat,active_usernames:['public']}));
  assert.throws(()=>validateTelegramIdentity(me,{...chat,title:'Other'}));
});
test('SSH uses existing socket no auth/reconnect fallback and fixed registered alias',()=>{
  const args=sshArgs('/tmp/existing.socket','bounded command');
  for(const value of ['ControlMaster=no','BatchMode=yes','IdentitiesOnly=yes','PreferredAuthentications=publickey',
    'PasswordAuthentication=no','KbdInteractiveAuthentication=no','NumberOfPasswordPrompts=0','ConnectionAttempts=1','ProxyCommand=false'])assert.ok(args.includes(value));
  assert.deepEqual(args.slice(-2),['news-vps','bounded command']);
  assert.throws(()=>sshArgs('relative','x'));
});
test('runtime gate checks actual config, rolling quota and deterministic cooldown bounds',()=>{
  validateRemotePreflight(config(),30);
  for(const delta of [{ingress:false},{synthetic:false},{knowledge:false},{provider:false},{analyzerMode:'off'},
    {exempt:true},{ownBot:true},{syntheticAllowed:false},{databasePath:'/other'},{cooldownSec:121},
    {quota:{used:190}},{assistantUsername:'other'}])assert.throws(()=>validateRemotePreflight({...config(),...delta},30));
  // Runtime 0 means unbounded; the runner's plan cap still bounds traffic.
  validateRemotePreflight({...config(),dailyCap:0},30);
});
test('reconciliation ties Telegram message revision, receipt event, user and delivery',()=>{
  assert.equal(validateReconciliation(reconciled(),'123',1000),true);
  assert.equal(validateReconciliation({receipt:null},'123',1000),false);
  const mutators=[d=>d.receipt.revision_identity='wrong',d=>d.receipt.receipt_id='assistant:9999',
    d=>d.receipt.received_at=1,d=>d.event.update_id=3,d=>d.claim.outcome='cooldown',
    d=>d.answer.user_id='other',d=>d.answer.delivery='partial',d=>d.event.result.receipt.messageId=null,
    d=>d.receipt.status='uncertain'];
  for(const mutate of mutators){const d=reconciled();mutate(d);assert.throws(()=>validateReconciliation(d,'123',1000));}
});
test('menu prompt is linked to exact command sender and reply message id',()=>{
  const data=reconciled('123',true);
  assert.equal(validateReconciliation(data,'123',1000,{menu:true}),true);
  data.event.result.askPrompt.userId='wrong';
  assert.throws(()=>validateReconciliation(data,'123',1000,{menu:true}));
});
test('remote reconciliation readonly script parameterizes exact own identity and retains usage',()=>{
  const statements=[];let opened;let output;
  class DB {
    constructor(path,options){opened={path,options};}
    prepare(sql){return {all:(...args)=>{statements.push({sql,args});return [{receipt_id:'assistant:1123'}];},
      get:(...args)=>{statements.push({sql,args});if(sql.includes('runtime_inbound_events'))return {event_id:'assistant:1123',result_json:'null'};return null;}};}
    close(){}
  }
  runInNewContext(remoteScript({operation:'reconcile',messageId:'123'}),{require:name=>name==='better-sqlite3'?DB:{},
    console:{log:raw=>{output=JSON.parse(raw);},error:()=>{}},process:{}});
  assert.equal(opened.path,TARGET.db);assert.equal(opened.options.readonly,true);assert.equal(opened.options.fileMustExist,true);
  assert.ok(output.receipt);
  const answer=statements.find(s=>s.sql.includes('FROM runtime_assistant_answer_records'));
  assert.deepEqual(Array.from(answer.args),['assistant:1123',TARGET.chatId,TARGET.syntheticUserId]);
  assert.match(answer.sql,/input_tokens,output_tokens,total_tokens/u);
  assert.match(remoteScript({operation:'preflight'}),/created_at > \?/u);
  assert.throws(()=>remoteScript({operation:'reconcile',messageId:'123; DROP'}));
});
test('serial happy path persists intent first and exact receipts and token data',async()=>{
  const h=harness();const result=await runAcceptance(plan(),[one],SHA,h);
  assert.equal(result.completed,1);
  assert.deepEqual(h.calls.filter(c=>c.method).map(c=>c.method),['getMe','getChat','sendMessage']);
  assert.ok(h.rows.findIndex(r=>r.type==='send_intent')<h.rows.findIndex(r=>r.type==='sent'));
  const answer=h.rows.find(r=>r.type==='answer');assert.equal(answer.answer.input_tokens,12);
  assert.equal(answer.messageId,'123');assert.equal(answer.answer.event_id,'assistant:1123');
});
test('ambiguous Telegram send stops without retry or next case',async()=>{
  const h=harness({sendFailure:true});
  await assert.rejects(runAcceptance(plan([one,{...one,id:'Q02'}]),[one,{...one,id:'Q02'}],SHA,h),/SEND_AMBIGUOUS/);
  assert.equal(h.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal(h.rows.filter(r=>r.type==='send_intent').length,1);
});
test('transport failure is terminal without Telegram resend',async()=>{
  const h=harness();const base=h.remote.query;h.remote.query=async req=>req.operation==='reconcile'?Promise.reject(Error('TRANSPORT_UNAVAILABLE')):base(req);
  await assert.rejects(runAcceptance(plan(),[one],SHA,h),/TRANSPORT_UNAVAILABLE/);
  assert.equal(h.calls.filter(c=>c.method==='sendMessage').length,1);
});
test('120 second pending deadline stops and polling passes remaining timeout',async()=>{
  const h=harness({pending:true});
  await assert.rejects(runAcceptance(plan(),[one],SHA,h),/RECONCILIATION_TIMEOUT/);
  assert.ok(h.now()-1000_000<=120_000);
  assert.equal(h.calls.filter(c=>c.method==='sendMessage').length,1);
  assert.ok(h.calls.filter(c=>c.remote?.operation==='reconcile').every(c=>c.timeout>0&&c.timeout<=120_000));
});
test('menu sends bare command then exact reply and verifies both cleanup states',async()=>{
  const h=harness({menu:true});const c={...one,mode:'menu_reply'};
  const result=await runAcceptance(plan([c]),[c],SHA,h);
  assert.equal(result.completed,1);
  const sends=h.calls.filter(c=>c.method==='sendMessage');assert.equal(sends.length,2);
  assert.equal(sends[0].params.text,`/ask@${TARGET.assistantUsername}`);
  assert.equal(sends[1].params.text,one.question);
  assert.deepEqual(sends[1].params.reply_parameters,{message_id:987,allow_sending_without_reply:false});
  assert.equal(h.rows.find(r=>r.type==='cleanup').cleanup.command.state,'deleted');
});
test('wrong deployed SHA fails before first Telegram message',async()=>{
  const h=harness();await assert.rejects(runAcceptance(plan(),[one],'b'.repeat(40),h),/SHA_MISMATCH/);
  assert.equal(h.calls.filter(c=>c.method==='sendMessage').length,0);
});
test('default dry-run only reads plan; no secret, network or output directory',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'assistant-acceptance-test-'));const path=join(dir,'plan.json');
  writeFileSync(path,JSON.stringify(plan()));
  const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('network forbidden');};
  try {const result=await main(['--plan',path]);assert.equal(result.mode,'dry-run');assert.equal(result.questions,1);}
  finally {globalThis.fetch=old;}
  assert.equal(JSON.parse(readFileSync(path)).cases.length,1);
});
