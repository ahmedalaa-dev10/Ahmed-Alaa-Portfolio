import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function ask(prompt) {
  const line = createInterface({ input: stdin, output: stdout });
  try { return (await line.question(prompt)).trim(); }
  finally { line.close(); }
}

export function hidden(prompt) {
  if (!stdin.isTTY) throw new Error('شغّل الأمر في Terminal تفاعلي لحماية كلمات المرور والمفاتيح.');
  return new Promise((resolve, reject) => {
    let answer = '';
    stdout.write(prompt); stdin.setRawMode(true); stdin.setEncoding('utf8'); stdin.resume();
    const finish = () => { stdin.removeListener('data', input); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); };
    const input = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(); reject(new Error('تم إلغاء الأمر.')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(answer); return; }
        if (char === '\u007f' || char === '\b') answer = answer.slice(0, -1);
        else if (char.charCodeAt(0) >= 32) answer += char;
      }
    };
    stdin.on('data', input);
  });
}
