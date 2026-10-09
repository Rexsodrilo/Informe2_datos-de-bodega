// authControl.js
// Restricción simple del panel de control privado (control.html) — misma
// lógica que auth.js (carga de datos), pero con su propia clave y su propio
// estado, para que desbloquear uno no desbloquee el otro.
//
// IMPORTANTE (igual que auth.js): esto es "seguridad por oscuridad", no
// autenticación real — cualquiera que revise el código fuente puede ver el
// hash/lógica. Proporcional al riesgo real de este proyecto (informe interno
// de bodega), no reemplaza un control de acceso serio si hiciera falta.
//
// La contraseña se guarda como hash SHA-256 (no en texto plano). Cambiar
// CONTROL_PASSWORD_HASH por el hash de la contraseña real antes de publicar.

// Hash SHA-256 de la contraseña real del panel de control ("Rexo01"). Para
// generar el hash de una nueva contraseña, abre la consola del navegador en
// esta página y ejecuta:
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode('tu_clave'))
//     .then(b => console.log([...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('')))
const CONTROL_PASSWORD_HASH = 'bfa8e118cf2a1b2cfb02905b6e7f3411c835b580c95c1407ca76b54d03e2a3d9';

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_KEY = 'dashboard_control_unlocked';

export function isControlUnlocked() {
  return sessionStorage.getItem(SESSION_KEY) === '1';
}

export async function tryUnlockControl(password) {
  const hash = await sha256(password);
  const ok = hash === CONTROL_PASSWORD_HASH;
  if (ok) sessionStorage.setItem(SESSION_KEY, '1');
  return ok;
}

export function lockControl() {
  sessionStorage.removeItem(SESSION_KEY);
}
