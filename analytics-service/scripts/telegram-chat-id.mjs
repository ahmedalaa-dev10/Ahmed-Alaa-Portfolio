import { hidden } from './prompts.mjs';

try {
  console.log('افتح البوت الذي أنشأته، واضغط Start أو أرسل له رسالة من حساب Telegram الشخصي الذي سيستقبل التنبيهات.');
  const token = (await hidden('مفتاح البوت من BotFather (الإدخال مخفي): ')).trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('مفتاح البوت غير صالح.');
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }), signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('تعذّر الاتصال بـTelegram. حاول مجددًا.'); }
  let body;
  try { body = await response.json(); } catch { throw new Error('تعذّر قراءة رد Telegram.'); }
  if (!response.ok || !body.ok) throw new Error('لم ينجح قراءة Chat ID. تحقق من المفتاح وأن هذا البوت مخصص للتنبيهات ولا يستخدم Webhook لخدمة أخرى.');
  const chats = new Map();
  for (const update of body.result || []) {
    const chat = update.message?.chat;
    if (chat?.type === 'private' && Number.isSafeInteger(chat.id) && chat.id > 0) chats.set(String(chat.id), chat);
  }
  if (!chats.size) throw new Error('لم تظهر محادثة شخصية. أرسل رسالة جديدة للبوت من حسابك ثم أعد الأمر.');
  console.log('\nالمحادثات الشخصية الحديثة — اختر Chat ID الخاص بحسابك فقط:');
  for (const [id, chat] of chats) {
    const label = [chat.first_name, chat.last_name, chat.username ? '@' + chat.username : ''].filter(Boolean).join(' ').replace(/[\r\n\x00-\x1f]/g, '').slice(0, 120);
    console.log(`${label || 'حساب شخصي'} — Chat ID: ${id}`);
  }
  console.log('\nلا يرسل هذا الأمر تنبيهات ولا يحفظ المفتاح أو بيانات الحساب في ملفات.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
