// Consultas al mock de los módulos dependientes (WireMock) desde k6.
//
// Sirven para verificar lo que M5 le pidió a M2, M4 y M8 aunque la API de M5
// no lo exponga (por ejemplo, la búsqueda que M5 dispara en segundo plano).
// Es igual en G04 y G13.
//
// Variables de entorno:
//   MOCKS_URL  URL del WireMock (por defecto http://127.0.0.1:8089)

import http from 'k6/http';
import { sleep } from 'k6';

const MOCKS_URL = (__ENV.MOCKS_URL || 'http://127.0.0.1:8089').replace(/\/$/, '');

const PARAMS = {
  headers: { 'Content-Type': 'application/json' },
  tags: { name: 'mock: contar pedidos' },
  responseCallback: http.expectedStatuses(200),
};

// Cuenta los pedidos recibidos por el mock que cumplen el patrón de WireMock
// (method, urlPath o urlPathPattern, queryParameters, bodyPatterns...).
export function contar(patron) {
  const res = http.post(`${MOCKS_URL}/__admin/requests/count`, JSON.stringify(patron), PARAMS);
  try {
    return res.json().count;
  } catch (e) {
    return -1;
  }
}

// Espera hasta `segundos` a que el mock reciba al menos `minimo` pedidos que
// cumplan el patrón. Devuelve la cantidad final.
export function esperar(patron, { minimo = 1, segundos = 10 } = {}) {
  const limite = Date.now() + segundos * 1000;
  let n = contar(patron);
  while (n < minimo && Date.now() < limite) {
    sleep(0.25);
    n = contar(patron);
  }
  return n;
}
