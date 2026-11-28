// sessionStorage es propio de la pestaña y se conserva al cambiar de modo.
const CLAVE = 'cine.sesion';

function vigente(sesion) {
  return typeof sesion?.usuario === 'string' && sesion.usuario.length > 0 &&
    typeof sesion.token === 'string' && sesion.token.length > 0 &&
    Number.isSafeInteger(sesion.exp) && sesion.exp * 1000 > Date.now();
}

export function leerSesion() {
  try {
    sessionStorage.removeItem('cine_demo_token'); // Clave del antiguo formulario manual.
    const sesion = JSON.parse(sessionStorage.getItem(CLAVE));
    if (vigente(sesion)) return sesion;
    sessionStorage.removeItem(CLAVE);
  } catch {
    // Un dato corrupto o almacenamiento no disponible lleva a la pantalla de acceso.
  }
  return null;
}

export function guardarSesion(sesion) {
  if (!vigente(sesion)) throw new Error('El servidor devolvió una sesión inválida.');
  try {
    sessionStorage.setItem(CLAVE, JSON.stringify(sesion));
  } catch {
    throw new Error('Habilitá el almacenamiento de esta pestaña para iniciar sesión.');
  }
}

export function irAlLogin(modo, vencida = false) {
  const url = new URL('login.html', window.location.href);
  if (modo === 'polling') url.searchParams.set('modo', 'polling');
  if (vencida) url.searchParams.set('motivo', 'vencida');
  window.location.replace(url);
}

export function borrarSesion() {
  sessionStorage.removeItem(CLAVE);
}
