/* Cloud sync for Moy Plan. Client key must be publishable/anon, never service_role. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const cfg=window.MOY_PLAN_CLOUD||{};
let client=null,user=null,revision=0,ready=false,dirty=false,conflict=null,saving=false,timer=null,channel=null;
const prefix='moy_plan_cloud_';
const status=t=>{if($('cloudStatus'))$('cloudStatus').textContent=t;};
const show=(id,v)=>{if($(id))$(id).hidden=!v;};
const backup=(name,value)=>{try{const key=prefix+name+'_'+Date.now();localStorage.setItem(key,JSON.stringify(value));}catch(e){console.warn('Аварийная копия не создана: недостаточно места',e)}};
function refresh(){
show('cloudSignOut',!!user);show('cloudUpload',!!user&&!ready&&!conflict);show('cloudReload',!!user&&ready&&!conflict);
show('cloudUseRemote',!!user&&!!conflict);show('cloudKeepLocal',!!user&&!!conflict);
if(!client)status('Облако не настроено. Заполни config.js.');else if(!user)status('Войди, чтобы включить единый прогресс.');
else if(conflict)status('⚠ Конфликт версий: выбери, какую сохранить.');
else if(!ready)status('☁ Облако пусто. Нажми «Перенести в облако».');
else if(dirty||saving)status('⟳ Синхронизация…');else status('✓ Синхронизировано · '+user.email);
}
function apply(payload,rev){
if(!payload||!Array.isArray(payload.tasks)||!Array.isArray(payload.grades))throw Error('Неверные данные облака');
state={...payload,version:6};
state.reviews=Array.isArray(state.reviews)?state.reviews:[];
state.digests=state.digests||{};state.digestQuizAnswers=state.digestQuizAnswers||{};
state.dayNotes=state.dayNotes||{};state.notifications=state.notifications||{};
state.reviewDeletedSources=state.reviewDeletedSources||[];state.settings={reminderTime:'09:00',...(state.settings||{})};
if(typeof reconcileDermDailyTasks==='function')reconcileDermDailyTasks();
if(typeof installBuiltinDigests==='function')installBuiltinDigests();
revision=Number(rev);ready=true;dirty=false;conflict=null;
try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){console.warn('Локальное хранилище переполнено; данные загружены из облака',e);notify('Облако загружено, но памяти браузера не хватает. Скачай резервную копию.')}localStorage.setItem(prefix+'account',user.id);
localStorage.setItem(prefix+'dirty','0');localStorage.setItem(prefix+'revision',String(revision));
if($('reminderTime'))$('reminderTime').value=state.settings.reminderTime;
render();refresh();
}
async function remote(){
const {data,error}=await client.from('planner_state').select('payload,revision').eq('user_id',user.id).maybeSingle();
if(error)throw error;return data;
}
async function upload(){
if(!client||!user||!ready||!dirty||saving||conflict)return;
saving=true;dirty=false;const snapshot=JSON.parse(JSON.stringify(state));refresh();
try{
const {data,error}=await client.rpc('save_planner_state',{p_state:snapshot,p_expected_revision:revision});
if(error)throw error;const r=Array.isArray(data)?data[0]:data;
if(!r)throw Error('Ответ сервера пуст');
if(!r.ok){conflict={payload:r.current_data,revision:Number(r.new_revision)};dirty=true;}
else {revision=Number(r.new_revision);localStorage.setItem(prefix+'revision',String(revision));localStorage.setItem(prefix+'account',user.id);if(!dirty)localStorage.setItem(prefix+'dirty','0');}
}catch(e){dirty=true;console.warn(e);status('Ошибка сети: '+e.message);}
finally{saving=false;refresh();if(dirty&&!conflict){clearTimeout(timer);timer=setTimeout(upload,5000);}}
}
window.queueCloudSave=()=>{
if(!client||!user||!ready)return;
dirty=true;localStorage.setItem(prefix+'dirty','1');refresh();
if(!conflict){clearTimeout(timer);timer=setTimeout(upload,1000);}
};
async function check(){
if(!client||!user||!ready||saving||conflict)return;
try{const row=await remote();if(!row||Number(row.revision)<=revision)return;
if(dirty||localStorage.getItem(prefix+'dirty')==='1'){conflict={payload:row.payload,revision:Number(row.revision)};refresh();}
else apply(row.payload,row.revision);
}catch(e){console.warn(e);}
}
async function signed(session){
const next=session?.user||null;if(next?.id===user?.id)return;
if(channel){client.removeChannel(channel);channel=null;}
user=next;ready=false;dirty=false;conflict=null;revision=0;refresh();
if(!user)return;
try{
const row=await remote();
if(!row){ready=false;}
else if(localStorage.getItem(prefix+'dirty')==='1'&&localStorage.getItem(prefix+'account')===user.id){conflict={payload:row.payload,revision:Number(row.revision)};}
else if(localStorage.getItem(prefix+'account')!==user.id && (state.grades.length||state.tasks.some(t=>t.done)||Object.keys(state.dayNotes||{}).length||Object.keys(state.digests||{}).length)){
conflict={payload:row.payload,revision:Number(row.revision)};
}else apply(row.payload,row.revision);
channel=client.channel('planner-'+user.id).on('postgres_changes',{event:'*',schema:'public',table:'planner_state',filter:'user_id=eq.'+user.id},check).subscribe();
}catch(e){status('Не удалось загрузить данные: '+e.message);}
refresh();
}
$('cloudOpen').onclick=()=>$('cloudModal').classList.add('open');
$('cloudModalClose').onclick=()=>$('cloudModal').classList.remove('open');
$('cloudModal').addEventListener('click',e=>{if(e.target===$('cloudModal'))$('cloudModal').classList.remove('open');});
async function auth(create){
if(!client)return notify('Сначала настрой Supabase в config.js');
const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
if(!email||password.length<6)return notify('Нужны email и пароль от 6 символов');
try{const {data,error}=create?await client.auth.signUp({email,password}):await client.auth.signInWithPassword({email,password});
if(error)throw error;$('cloudPassword').value='';$('cloudModal').classList.remove('open');
notify(create&&!data.session?'Проверь почту и подтверди регистрацию':'Вход выполнен');
}catch(e){status('Ошибка входа: '+e.message);}
}
$('cloudLogin').onclick=()=>auth(false);$('cloudRegister').onclick=()=>auth(true);
$('cloudSignOut').onclick=async()=>{
if(dirty&&!confirm('Несинхронизированные изменения останутся только здесь. Выйти?'))return;
await client.auth.signOut();notify('Выход выполнен');
};
$('cloudUpload').onclick=async()=>{
if(!user||!confirm('Перенести локальный план и все отметки в облако?'))return;
revision=0;ready=true;dirty=true;localStorage.setItem(prefix+'account',user.id);localStorage.setItem(prefix+'dirty','1');await upload();
};
$('cloudReload').onclick=async()=>{if(dirty&&!confirm('Загрузить облачную версию вместо локальной?'))return;
try{const row=await remote();if(row)apply(row.payload,row.revision);}catch(e){notify('Ошибка: '+e.message);}
};
$('cloudUseRemote').onclick=()=>{if(!conflict||!confirm('Принять облачную версию? Локальная сохранится в аварийной копии браузера.'))return;apply(conflict.payload,conflict.revision);};
$('cloudKeepLocal').onclick=async()=>{if(!conflict||!confirm('Перезаписать облако текущими данными устройства?'))return;
backup('remote_backup',conflict.payload);revision=conflict.revision;conflict=null;ready=true;dirty=true;localStorage.setItem(prefix+'dirty','1');await upload();
};
$('cloudRetry').onclick=()=>{if(user&&ready){dirty=true;upload();}else notify('Сначала войди и загрузи план');};
$('cloudClearSnapshots').onclick=()=>{
 const keys=Object.keys(localStorage).filter(k=>k.startsWith(prefix+'before_remote_')||k.startsWith(prefix+'remote_backup_'));
 if(!keys.length)return notify('Старых аварийных копий нет');
 if(!confirm('Удалить '+keys.length+' старых аварийных копий из памяти Safari? Сначала скачай резервную копию. Основной план и данные облака не удаляются.'))return;
 keys.forEach(k=>localStorage.removeItem(k));
 if(typeof save==='function')save();
 notify('Старые аварийные копии очищены');
};
$('cloudDownloadSnapshot').onclick=()=>{
const keys=Object.keys(localStorage).filter(k=>k.startsWith(prefix+'before_remote_')||k.startsWith(prefix+'remote_backup_')).sort();
if(!keys.length)return notify('Аварийных снимков пока нет');
const k=keys[keys.length-1];download(JSON.parse(localStorage.getItem(k)),'moy-plan-snapshot.json');
};

window.pullChatGrades=async()=>{
 if(!client||!user){notify('Сначала войди в облачный аккаунт планера');return}
 const btn=$('pullChatGrades');if(btn){btn.disabled=true;btn.textContent='⟳ Загружаю оценки…'}
 try{
  const {data,error}=await client.from('chatgpt_grade_inbox').select('id,grade_date,block,title,score,feedback,imported_at').eq('user_id',user.id).is('imported_at',null).order('created_at',{ascending:true});
  if(error)throw error;
  if(!data?.length){notify('Новых оценок из ChatGPT пока нет');return}
  let count=0;
  for(const g of data){
   const gid='chatgpt-grade-'+g.id;
   if(!state.grades.some(x=>x.id===gid)){state.grades.push({id:gid,date:g.grade_date,block:g.block,title:g.title,score:g.score,feedback:g.feedback});count++}
  }
  save();
  const {error:ackError}=await client.from('chatgpt_grade_inbox').update({imported_at:new Date().toISOString()}).in('id',data.map(g=>g.id)).eq('user_id',user.id);
  if(ackError)console.warn('Не удалось отметить импорт оценок',ackError);
  switchView('grades');notify('Загружено оценок: '+count);
 }catch(e){console.error(e);notify('Ошибка загрузки оценок: '+e.message)}
 finally{if(btn){btn.disabled=false;btn.textContent='↻ Забрать оценки из ChatGPT'}}
};
refresh();
if(/^https:\/\/[\w.-]+\.supabase\.co\/?$/.test(cfg.url||'') && (cfg.publishableKey||'').length>15 && window.supabase?.createClient){
client=window.supabase.createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
client.auth.onAuthStateChange((_e,s)=>setTimeout(()=>signed(s),0));
client.auth.getSession().then(({data})=>signed(data?.session)).catch(e=>status(e.message));
window.addEventListener('focus',check);document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});
setInterval(check,20000);
}else refresh();
})();