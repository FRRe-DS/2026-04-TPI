// E2E funcional de M5 (Solicitud y Despacho) con k6 - implementación G04.
//
// Corre con 1 VU y 1 iteración: no es una prueba de carga sino la verificación
// de un flujo de punta a punta contra la app real (MySQL real + mocks de M1, M2,
// M3, M4, M6, M7 y M8). Es la base de los escenarios de carga A-D del Hito 3.
//
// El flujo 1 (solicitud inmediata) verifica lo mismo que el E2E de G13; los demás
// recorren el despacho completo, que en G04 ya está integrado.
//
// Uso:
//   k6 run -e BASE_URL=http://127.0.0.1:3001 -e MOCKS_URL=http://127.0.0.1:8089 \
//          -e M1_TOKEN_CLIENTE=... -e M1_TOKEN_SIN_ROL=... -e M1_TOKEN_M3=... -e M1_CLIENTE_ID=... \
//          devops/k6/e2e.js
// (los tokens los genera devops/ci/m1_tokens_prueba.py)
//
// El mock de M4 (devops/mocks) devuelve 2 candidatos AUTO y ninguno MOTO.

import { check, group, sleep } from 'k6';
import http from 'k6/http';
import * as m5 from './lib/api.js';
import * as mock from './lib/mocks.js';

export const options = {
  scenarios: {
    e2e: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '3m' },
  },
  thresholds: {
    // Un E2E pasa solo si pasan TODAS las verificaciones...
    checks: ['rate==1.0'],
    // ...y ninguna respuesta fue un código no esperado por el paso.
    http_req_failed: ['rate==0'],
  },
};

const TOKEN_CLIENTE = __ENV.M1_TOKEN_CLIENTE;
const TOKEN_SIN_ROL = __ENV.M1_TOKEN_SIN_ROL;
const TOKEN_M3 = __ENV.M1_TOKEN_M3;
const CLIENTE_ID = __ENV.M1_CLIENTE_ID;

// Conductores que devuelve el mock de M4 para AUTO.
const CONDUCTORES_M4 = ['018f1f20-7b4a-7cc2-9d41-66382a18cc5a', '018f1f20-7b4a-7cc2-9d41-66382a18cc5b'];

// Resistencia, Chaco.
const ORIGEN = { lat: -27.4512, lon: -58.9867 };
const DESTINO = { lat: -27.4692, lon: -58.8306 };

function nuevaSolicitud(tipoVehiculo) {
  const res = m5.crearSolicitud(
    { token: TOKEN_CLIENTE, idempotencyKey: crypto.randomUUID(), origen: ORIGEN, destino: DESTINO, tipoVehiculo },
    [201],
  );
  const ok = check(res, { [`crear solicitud ${tipoVehiculo}: 201`]: (r) => r.status === 201 });
  return ok ? m5.solicitudId(res) : null;
}

// Consulta la solicitud hasta que llegue al estado esperado (o se agote el tiempo).
function esperarEstado(id, esperado, segundos = 10) {
  const limite = Date.now() + segundos * 1000;
  let res = m5.obtenerSolicitud(id, TOKEN_CLIENTE, [200]);
  while (m5.estado(res) !== esperado && Date.now() < limite) {
    sleep(0.5);
    res = m5.obtenerSolicitud(id, TOKEN_CLIENTE, [200]);
  }
  return res;
}

// Consulta las ofertas hasta que haya `cantidad` (o se agote el tiempo).
function esperarOfertas(id, cantidad, segundos = 10) {
  const limite = Date.now() + segundos * 1000;
  let ofertas = m5.lista(m5.listarOfertas(id, TOKEN_M3, [200])) || [];
  while (ofertas.length < cantidad && Date.now() < limite) {
    sleep(0.5);
    ofertas = m5.lista(m5.listarOfertas(id, TOKEN_M3, [200])) || [];
  }
  return ofertas;
}

export function setup() {
  check(m5.salud(), { 'health: 200': (r) => r.status === 200 });
  check(m5.listo(), { 'health/ready: 200 con la base conectada': (r) => r.status === 200 });
  if (!TOKEN_CLIENTE || !TOKEN_SIN_ROL || !TOKEN_M3 || !CLIENTE_ID) {
    throw new Error('Faltan los tokens M1_* (ver devops/ci/m1_tokens_prueba.py)');
  }
}

export default function () {
  let solicitud = null;

  group('1. Solicitud inmediata (RF-5.1): M1 -> M2 -> M4/M7 (tarifa)', () => {
    const base = { origen: ORIGEN, destino: DESTINO, tipoVehiculo: 'AUTO' };
    const clave = crypto.randomUUID();

    const sinToken = m5.crearSolicitud(Object.assign({ token: null, idempotencyKey: clave }, base), [401]);
    check(sinToken, { 'sin token: 401': (r) => r.status === 401 });

    const sinRol = m5.crearSolicitud(Object.assign({ token: TOKEN_SIN_ROL, idempotencyKey: clave }, base), [403]);
    check(sinRol, { 'token sin rol CLIENTE: 403': (r) => r.status === 403 });

    const sinClave = m5.crearSolicitud(Object.assign({ token: TOKEN_CLIENTE, idempotencyKey: null }, base), [400]);
    check(sinClave, { 'sin Idempotency-Key: 400': (r) => r.status === 400 });

    const res = m5.crearSolicitud(Object.assign({ token: TOKEN_CLIENTE, idempotencyKey: clave }, base), [201]);
    const id = m5.solicitudId(res);
    const ok = check(res, {
      'crear solicitud: 201': (r) => r.status === 201,
      'crear solicitud: estado pendiente': (r) => m5.estado(r) === 'pendiente',
      'crear solicitud: el cliente sale del token': (r) => m5.campo(r, 'cliente_id') === CLIENTE_ID,
      'crear solicitud: header Location': (r) => (r.headers.Location || '').endsWith(`/solicitudes/${id}`),
      'crear solicitud: tarifa estimada por M7': (r) => (m5.campo(r, 'tarifa_estimada') || {}).total_estimado === 4400,
    });
    if (!ok) return;
    solicitud = id;

    const repetida = m5.crearSolicitud(Object.assign({ token: TOKEN_CLIENTE, idempotencyKey: clave }, base), [200]);
    check(repetida, {
      'misma Idempotency-Key: 200 con la misma solicitud': (r) => r.status === 200 && m5.solicitudId(r) === id,
    });

    const otroCuerpo = Object.assign({}, base, { tipoVehiculo: 'MOTO' });
    const conflicto = m5.crearSolicitud(Object.assign({ token: TOKEN_CLIENTE, idempotencyKey: clave }, otroCuerpo), [409]);
    check(conflicto, { 'misma Idempotency-Key con otros datos: 409': (r) => r.status === 409 });

    const consultasM2 = mock.contar({ method: 'GET', urlPath: `/api/v1/clientes/${CLIENTE_ID}/estado-cuenta` });
    check(null, { 'M2: estado de cuenta consultado una sola vez': () => consultasM2 === 1 });
  });

  let ofertas = [];
  group('2. Despacho (RF-5.3/5.4): candidatos de M4 -> reserva en M4 -> ofertas por M3', () => {
    if (!solicitud) return;

    ofertas = esperarOfertas(solicitud, CONDUCTORES_M4.length);
    check(null, {
      'ofertas: una por cada candidato de M4': () => ofertas.length === CONDUCTORES_M4.length,
      'ofertas: todas pendientes': () => ofertas.length > 0 && ofertas.every((o) => o.estado === 'pendiente'),
      'ofertas: a los conductores que devolvió M4': () =>
        ofertas.map((o) => o.conductor_id).sort().join() === [...CONDUCTORES_M4].sort().join(),
    });

    const reservas = mock.contar({
      method: 'POST',
      urlPathPattern: '/api/v1/conductores/.*/reserva',
      bodyPatterns: [{ contains: solicitud }, { contains: 'RESERVADO' }],
    });
    check(null, { 'M4: cada conductor reservado antes de ofertarle': () => reservas === CONDUCTORES_M4.length });

    const enviadasM3 = mock.contar({
      method: 'POST',
      urlPath: '/api/v1/integration/m5/offers',
      bodyPatterns: [{ contains: solicitud }],
    });
    check(null, { 'M3: recibió una oferta por conductor': () => enviadasM3 === CONDUCTORES_M4.length });

    // Mientras hay ofertas en curso, la solicitud tiene que estar en búsqueda: es la
    // condición que la aceptación exige para asignar (RF-5.6).
    const res = m5.obtenerSolicitud(solicitud, TOKEN_CLIENTE, [200]);
    check(res, { 'solicitud en búsqueda mientras hay ofertas': (r) => m5.estado(r) === 'buscando' });
  });

  group('3. Asignación única (RF-5.5/5.6, RNF-08): dos conductores aceptan a la vez', () => {
    if (!solicitud || ofertas.length < 2) return;

    const respuestas = http.batch(ofertas.slice(0, 2).map((o) => m5.pedidoRespuestaOferta(
      { ofertaId: o.oferta_id, conductorId: o.conductor_id, decision: 'ACCEPTED', token: TOKEN_M3 },
      [200, 409],
    )));
    const codigos = respuestas.map((r) => r.status).sort();
    const iGanador = respuestas.findIndex((r) => r.status === 200);
    const ganador = iGanador >= 0 ? ofertas[iGanador].conductor_id : null;
    check(null, {
      'aceptaciones simultáneas: una gana (200) y la otra recibe 409': () => codigos.join() === '200,409',
      'el ganador recibe ACCEPTED y el id del viaje': () =>
        iGanador >= 0 && respuestas[iGanador].json('status') === 'ACCEPTED' && !!respuestas[iGanador].json('tripId'),
    });
    if (!ganador) return;

    const res = esperarEstado(solicitud, 'asignada');
    check(res, {
      'solicitud asignada': (r) => m5.estado(r) === 'asignada',
      'asignada al conductor que ganó': (r) => m5.campo(r, 'conductorId') === ganador,
    });

    const finales = m5.lista(m5.listarOfertas(solicitud, TOKEN_M3, [200])) || [];
    check(null, {
      'ofertas: la del ganador aceptada': () => finales.some((o) => o.conductor_id === ganador && o.estado === 'aceptada'),
      'ofertas: la otra cancelada': () => finales.some((o) => o.conductor_id !== ganador && o.estado === 'cancelada'),
    });

    const viajesM6 = mock.contar({
      method: 'POST',
      urlPath: '/trips',
      bodyPatterns: [{ contains: CLIENTE_ID }, { contains: ganador }],
    });
    check(null, { 'M6: un solo viaje creado': () => viajesM6 === 1 });

    const avisoM8 = mock.esperar({
      method: 'POST',
      urlPath: '/api/v1/eventos',
      bodyPatterns: [{ contains: CLIENTE_ID }, { contains: 'VIAJE_ASIGNADO' }],
    }, { segundos: 15 });
    check(null, { 'M8: recibió el evento VIAJE_ASIGNADO': () => avisoM8 >= 1 });
  });

  group('4. Sin conductores disponibles -> sin_disponibilidad', () => {
    const id = nuevaSolicitud('MOTO');
    if (!id) return;
    const res = esperarEstado(id, 'sin_disponibilidad');
    check(res, { 'sin candidatos en M4: estado sin_disponibilidad': (r) => m5.estado(r) === 'sin_disponibilidad' });
  });

  group('5. Cancelación previa a la asignación (RF-5.7)', () => {
    const id = nuevaSolicitud('AUTO');
    if (!id) return;
    esperarOfertas(id, CONDUCTORES_M4.length);

    const sinRol = m5.cancelarSolicitud(id, TOKEN_SIN_ROL, [403]);
    check(sinRol, { 'cancelar sin rol CLIENTE: 403': (r) => r.status === 403 });

    const cancel = m5.cancelarSolicitud(id, TOKEN_CLIENTE, [200]);
    check(cancel, {
      'cancelar: 200': (r) => r.status === 200,
      'cancelar: estado cancelada': (r) => m5.estado(r) === 'cancelada',
    });

    const otraVez = m5.cancelarSolicitud(id, TOKEN_CLIENTE, [200]);
    check(otraVez, { 'cancelar dos veces: 200 (idempotente)': (r) => r.status === 200 && m5.estado(r) === 'cancelada' });

    const ofertasFinales = m5.lista(m5.listarOfertas(id, TOKEN_M3, [200])) || [];
    check(null, {
      'cancelar: las ofertas en curso quedan canceladas': () =>
        ofertasFinales.length > 0 && ofertasFinales.every((o) => o.estado === 'cancelada'),
    });
  });
}
