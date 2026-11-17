#!/usr/bin/env node
// Genera ADMIN_PASSWORD_HASH (scrypt) sin guardar la contraseña en ningún lado.
// Uso: npm run hash-password   (te la pide por consola, sin mostrarla)
import { randomBytes, scrypt } from 'node:crypto';
import { stdin, stdout } from 'node:process';

function ask(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolve(value);
          return;
        } else if (ch === '\u0003') {
          process.exit(1);
        } else if (ch === '\u007f') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const password = await ask('Contraseña del panel (mínimo 14 caracteres): ');
if (password.length < 14) {
  console.error('Muy corta. Usá una frase larga, por ejemplo cuatro palabras al azar.');
  process.exit(1);
}
const N = 2 ** 15, r = 8, p = 1;
const salt = randomBytes(16);
scrypt(password.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => {
  if (err) throw err;
  console.log(`ADMIN_PASSWORD_HASH=scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`);
});
