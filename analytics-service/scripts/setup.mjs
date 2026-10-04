import { stdout } from 'node:process';
import { ask, hidden } from './prompts.mjs';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const wrangler = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js');
function command(args,{capture=false,input}={}) {
  const result=spawnSync(process.execPath,[wrangler,...args],{cwd:directory,encoding:'utf8',maxBuffer:4*1024*1024,env:{...process.env,CI:'true'},...(input !== undefined?{input,stdio:['pipe',capture?'pipe':'inherit',capture?'pipe':'inherit']}:{stdio:capture?'pipe':'inherit'})});
  if(result.status!==0){if(capture){stdout.write(result.stdout||'');stdout.write(result.stderr||'');}throw new Error('توقف الإعداد عند أمر Cloudflare. راجع الرسالة ثم أعد تشغيل npm run setup.');}
  if(capture)stdout.write(result.stdout||'');
  return result.stdout||'';
}
function secret(name,value){command(['secret','put',name],{input:value+'\n'});}

try {
  stdout.write('\nتفعيل سجل زيارات Ahmed Alaa — لا تُرفع مفاتيح أو كلمات مرور إلى GitHub.\n\n');
  let site=new URL(await ask('رابط البورتفوليو المنشور على GitHub Pages: '));
  if(site.protocol!=='https:'||site.username||site.password)throw new Error('استخدم رابط الموقع العام الذي يبدأ بـ https://.');
  site.search='';site.hash='';
  if(site.pathname.endsWith('/index.html'))site.pathname=site.pathname.slice(0,-10);
  if(!site.pathname.endsWith('/'))site.pathname+='/';
  const email=(await ask('البريد الذي ستستخدمه لحساب المالك: ')).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('البريد الإلكتروني غير صالح.');
  let password=await hidden('اختر كلمة مرور للوحة المالك (14 حرفًا أو أكثر؛ الإدخال مخفي): ');
  if(password.length<14||password.length>256)throw new Error('استخدم كلمة مرور بين 14 و256 حرفًا.');
  const confirmation=await hidden('أعد كلمة المرور: ');
  if(password!==confirmation)throw new Error('كلمتا المرور غير متطابقتين.');
  const salt=randomBytes(16).toString('hex');
  const saved='pbkdf2-sha256$100000$'+salt+'$'+pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex');
  const selected=(await ask('قناة التنبيه: 1 = Telegram، 2 = البريد [1]: '))||'1';
  const values={OWNER_EMAIL:email,OWNER_PASSWORD_HASH:saved,AUTH_SECRET:randomBytes(32).toString('hex')};
  let channel;
  if(selected==='1') {
    channel='telegram';values.TELEGRAM_BOT_TOKEN=await hidden('مفتاح البوت من BotFather (مخفي): ');values.TELEGRAM_CHAT_ID=await hidden('Chat ID لحسابك (مخفي): ');
    if(!/^\d+:[A-Za-z0-9_-]+$/.test(values.TELEGRAM_BOT_TOKEN)||!/^\d+$/.test(values.TELEGRAM_CHAT_ID))throw new Error('أدخل مفتاح بوت صحيحًا وChat ID شخصيًا رقميًا.');
  } else if(selected==='2') {
    channel='email';values.RESEND_API_KEY=await hidden('مفتاح Resend (مخفي): ');values.NOTIFY_FROM=await ask('عنوان مرسل موثّق في Resend: ');values.NOTIFY_TO=await hidden('عنوان بريدك المستلم للتنبيهات (مخفي): ');
    if(!values.RESEND_API_KEY||!values.NOTIFY_FROM||!values.NOTIFY_TO)throw new Error('بيانات البريد غير مكتملة.');
  } else throw new Error('اختر 1 أو 2.');
  stdout.write('\nسجّل الدخول الآن إلى حساب Cloudflare الذي سيستضيف خدمة السجل.\n');
  command(['login']);
  const configPath=path.join(directory,'wrangler.jsonc');
  const config=JSON.parse(await readFile(configPath,'utf8'));
  config.vars={...config.vars,SITE_URL:site.href,NOTIFICATION_CHANNEL:channel,RETENTION_DAYS:'90'};
  delete config.vars.OWNER_EMAIL;
  if(!config.d1_databases?.[0]?.database_id){
    const output=command(['d1','create','aa-portfolio-visits'],{capture:true});
    const id=/(?:"database_id"\s*:\s*"|database_id\s*=\s*")([\da-f-]{36})"/i.exec(output)?.[1];
    if(!id)throw new Error('لم يمكن قراءة database_id. راجع دليل التفعيل لإكمال ربط D1 يدويًا.');
    config.d1_databases=[{binding:'DB',database_name:'aa-portfolio-visits',database_id:id,migrations_dir:'migrations'}];
  }
  await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
  command(['d1','migrations','apply','aa-portfolio-visits','--remote']);
  const deployment=command(['deploy'],{capture:true});
  const serviceURL=deployment.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
  if(!serviceURL)throw new Error('لم يمكن قراءة رابط Worker. راجع دليل التفعيل لإكمال الإعداد يدويًا.');
  config.vars.SERVICE_URL=serviceURL;
  await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
  for(const [name,value]of Object.entries(values))secret(name,value);
  command(['deploy']);
  const response=await fetch(serviceURL+'/api/owner/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:serviceURL},body:JSON.stringify({email,password})});
  password='';
  if(!response.ok)throw new Error('نُشرت الخدمة لكن التحقق من تسجيل الدخول لم ينجح. لن يُفعّل التتبع قبل اكتمال التحقق.');
  const ownerCookie=response.headers.get('set-cookie')?.split(';')[0];
  await response.json();
  const check=await fetch(serviceURL+'/api/owner/summary',{headers:{Cookie:ownerCookie}});
  if(!check.ok)throw new Error('تعذّر التحقق من لوحة المالك. لن يُفعّل التتبع حتى تصبح قاعدة السجل جاهزة.');
  await check.json();
  await fetch(serviceURL+'/api/owner/logout',{method:'POST',headers:{'Content-Type':'application/json',Cookie:ownerCookie,Origin:serviceURL},body:'{}'});
  await writeFile(path.join(directory,'../assets/analytics-config.json'),JSON.stringify({enabled:true,endpoint:serviceURL+'/api/collect',respectPrivacySignals:true},null,2)+'\n');
  const linkedIn=new URL(site);linkedIn.searchParams.set('utm_source','linkedin');linkedIn.searchParams.set('utm_medium','social');linkedIn.searchParams.set('utm_campaign','portfolio');
  stdout.write('\nاكتمل إعداد الخدمة.\nلوحة المالك: '+serviceURL+'/owner\nرابط زر LinkedIn: '+linkedIn.href+'\n\nارفع assets/analytics-config.json المحدّث وبقية ملفات P01 إلى جذر مستودع البورتفوليو.\nاختبر التنبيه من زر «اختبار التنبيه» في اللوحة، ثم افتح رابط LinkedIn من متصفح آخر.\n');
}catch(error){console.error('\n'+error.message);process.exitCode=1;}
