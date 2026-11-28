const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { EstadoSolicitud } = require("../src/comun/estados");
const { mapSolicitud, crearPersistencia } = require("../src/main");

function crearPrismaSolicitudFalso(iniciales = []) {
  const solicitudes = iniciales.map((s) => ({ ...s }));
  return {
    solicitud: {
      async findUnique({ where, select } = {}) {
        const fila = solicitudes.find((s) => s.idSolicitud === where.idSolicitud);
        if (!fila) return null;
        if (!select) return { ...fila };
        return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, fila[k]]));
      },
      async updateMany({ where, data }) {
        const coincidencias = solicitudes.filter((s) =>
          Object.entries(where).every(([campo, valor]) => s[campo] === valor)
        );
        for (const fila of coincidencias) Object.assign(fila, data);
        return { count: coincidencias.length };
      },
    },
  };
}

describe("Solicitud — mapeo y persistencia condicional", () => {
  test("mapSolicitud convierte un registro Prisma al formato de respuesta de la API", () => {
    const fecha = new Date("2026-11-20T12:00:00.000Z");
    const vista = mapSolicitud({
      idSolicitud: "sol-1",
      idCliente: "cli-1",
      origenLat: -27.451,
      origenLng: -58.986,
      destinoLat: -27.465,
      destinoLng: -58.975,
      tipoVehiculo: "AUTO",
      vehiculo_id: null,
      costo: 5700,
      moneda: "ARS",
      tipoActivacion: "Inmediata",
      reservaId: null,
      conductorId: null,
      estado: EstadoSolicitud.BUSCANDO,
      creadaEn: fecha,
    });

    assert.deepEqual(vista, {
      solicitudId: "sol-1",
      clienteId: "cli-1",
      origen: { lat: -27.451, lng: -58.986 },
      destino: { lat: -27.465, lng: -58.975 },
      tipoVehiculo: "AUTO",
      vehiculo_id: null,
      costo: 5700,
      moneda: "ARS",
      tipoActivacion: "Inmediata",
      reservaId: null,
      conductorId: null,
      estado: "buscando",
      creadaEn: fecha.toISOString(),
      solicitud_id: "sol-1",
      cliente_id: "cli-1",
      origen_latitud: -27.451,
      origen_longitud: -58.986,
      destino_latitud: -27.465,
      destino_longitud: -58.975,
      tipo_vehiculo: "AUTO",
      conductor_id: undefined,
      reserva_id: undefined,
      tarifa_estimada: { moneda: "ARS", total_estimado: 5700 },
      creada_en: fecha.toISOString(),
    });
  });

  test("asignar solo permite ganar una vez cuando la solicitud está en buscando", async () => {
    const prisma = crearPrismaSolicitudFalso([
      {
        idSolicitud: "sol-1",
        idCliente: "cli-1",
        origenLat: -27.45,
        origenLng: -58.98,
        destinoLat: -27.46,
        destinoLng: -58.97,
        tipoVehiculo: "AUTO",
        conductorId: null,
        estado: EstadoSolicitud.BUSCANDO,
      },
    ]);
    const persistencia = crearPersistencia(prisma);

    const primero = await persistencia.solicitudes.asignar({ solicitudId: "sol-1", conductorId: "cond-1" });
    assert.deepEqual(primero, { resultado: "asignada" });

    const segundo = await persistencia.solicitudes.asignar({ solicitudId: "sol-1", conductorId: "cond-2" });
    assert.deepEqual(segundo, { resultado: "ya_asignada" });

    const estado = await persistencia.solicitudes.obtenerEstado("sol-1");
    assert.deepEqual(estado, { estado: "asignada", conductorAsignadoId: "cond-1" });
  });

  test("marcarSinDisponibilidad solo aplica si la solicitud sigue buscando", async () => {
    const prisma = crearPrismaSolicitudFalso([
      {
        idSolicitud: "sol-2",
        idCliente: "cli-1",
        origenLat: -27.45,
        origenLng: -58.98,
        destinoLat: -27.46,
        destinoLng: -58.97,
        tipoVehiculo: "MOTO",
        conductorId: null,
        estado: EstadoSolicitud.BUSCANDO,
      },
    ]);
    const persistencia = crearPersistencia(prisma);

    const r1 = await persistencia.solicitudes.marcarSinDisponibilidad({ solicitudId: "sol-2" });
    assert.deepEqual(r1, { aplicado: true, estadoActual: "sin_disponibilidad" });

    const r2 = await persistencia.solicitudes.marcarSinDisponibilidad({ solicitudId: "sol-2" });
    assert.deepEqual(r2, { aplicado: false, estadoActual: "sin_disponibilidad" });
  });
});
