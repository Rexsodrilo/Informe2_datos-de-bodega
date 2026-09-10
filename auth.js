// auth.js
// Restricción simple del botón de carga de datos a una sola persona.
//
// IMPORTANTE (ya conversado): esto es "seguridad por oscuridad", no
// autenticación real — cualquiera que revise el código fuente del sitio
// puede ver el hash/lógica. Es proporcional al riesgo real de este proyecto
// (informe interno de despacho, no datos financieros críticos), pero no
// reemplaza un control de acceso serio si más adelante se necesita.
//
// La contraseña se guarda como hash SHA-256 (no en texto plano) para que al
// menos no quede literal en el código fuente. Cambiar UPLOAD_PASSWORD_HASH
// por el hash de la contraseña real antes de publicar.

// Hash SHA-256 de la contraseña de ejemplo "despacho2026" — CAMBIAR antes de
// publicar. Para generar el hash de tu propia contraseña, abre la consola
// del navegador en esta página y ejecuta:
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('tu_clave'))
//     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
const UPLOAD_PASSWORD_HASH = '68ab01746d543878f8af6aef5c6c75b9831f3f5ef1a93bdb187979d9f8c8f207';

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_KEY = 'dashboard_upload_unlocked';

export function isUploadUnlocked() {
  return sessionStorage.getItem(SESSION_KEY) === '1';
}

export async function tryUnlock(password) {
  const hash = await sha256(password);
  const ok = hash === UPLOAD_PASSWORD_HASH;
  if (ok) sessionStorage.setItem(SESSION_KEY, '1');
  return ok;
}

export function lock() {
  sessionStorage.removeItem(SESSION_KEY);
}
