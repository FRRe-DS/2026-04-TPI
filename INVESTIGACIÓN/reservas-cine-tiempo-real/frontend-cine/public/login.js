import { leerSesion, guardarSesion } from './sesion.js';

const parametros = new URLSearchParams(window.location.search);
const destino = parametros.get('modo') === 'polling' ? 'polling.html' : 'index.html';
const formulario = document.getElementById('loginForm');
const boton = document.getElementById('ingresar');
const mensaje = document.getElementById('loginMensaje');

async function ingresar(evento) {
  evento.preventDefault();
  if (boton.disabled) return;
  boton.disabled = true;
  boton.textContent = 'Ingresando…';
  mensaje.textContent = '';
  const { usuario, clave } = formulario.elements;
  try {
    const respuesta = await fetch('/sesion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      body: JSON.stringify({ usuario: usuario.value.trim(), clave: clave.value })
    });
    if (respuesta.status === 401) {
      clave.select();
      clave.focus();
      throw new Error('Usuario o contraseña incorrectos.');
    }
    if (respuesta.status === 429) throw new Error('Demasiados intentos. Esperá unos segundos y volvé a intentar.');
    if (!respuesta.ok) throw new Error('No se pudo iniciar sesión. Volvé a intentar en unos segundos.');
    guardarSesion(await respuesta.json());
    clave.value = '';
    window.location.replace(destino);
  } catch (error) {
    mensaje.textContent = error instanceof TypeError
      ? 'No se pudo conectar con el servidor. Revisá la conexión y volvé a intentar.'
      : error.message;
  } finally {
    boton.disabled = false;
    boton.textContent = 'Ingresar';
  }
}

if (leerSesion()) {
  window.location.replace(destino);
} else {
  if (parametros.get('motivo') === 'vencida') mensaje.textContent = 'Tu sesión venció. Volvé a ingresar.';
  formulario.addEventListener('submit', ingresar);
}
