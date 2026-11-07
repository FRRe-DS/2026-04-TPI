// Implementaciones EN MEMORIA de los puertos (A, B e infraestructura) para probar la
// asignación sin base de datos. Se reemplazan por las reales cuando existan.
//
// LIMITACIÓN HONESTA: acá las transacciones se serializan con un candado global, que es
// MÁS fuerte que los bloqueos por fila de MySQL. Estas pruebas verifican la lógica
// (rollback, idempotencia, resultados). La prueba definitiva de concurrencia hay que
// repetirla contra MySQL real.
const {
  EstadoSolicitud,
  EstadoOferta,
  EstadoBusqueda,
} = require("../../src/comun/estados");
// El puerto de A devuelve el vocabulario DETALLADO; la simplificación a 5 códigos la hace B.
const { ResultadoPuertoAsignacion: R } = require("../../src/asignacion/resultados");

const pausa = (max = 3) => new Promise((r) => setTimeout(r, Math.random() * max));
const copia = (x) => (x ? structuredClone(x) : null);

function crearMundo({ solicitudes = [], ofertas = [], busquedas = [], candidatos = [], ahora = new Date("2026-10-20T12:00:00Z") } = {}) {
  const estado = {
    solicitudes: new Map(solicitudes.map((s) => [s.solicitudId, { ...s }])),
    ofertas: new Map(ofertas.map((o) => [o.ofertaId, { ...o }])),
    busquedas: new Map(busquedas.map((b) => [b.solicitudId, { ...b }])),
    // Lista que devolvió M4 (reservada en M4). Clave: solicitud + conductor.
    candidatos: new Map(candidatos.map((c) => [`${c.solicitudId}:${c.conductorId}`, { liberadoEn: null, ...c }])),
    eventos: [],
  };
  const espias = {
    cacheEliminado: [],
    conductorAsignado: [],
    liberados: [],
    fallar: { cache: false, conductorAsignado: false, liberar: false, liberarIds: [] },
  };
  let reloj = ahora;

  // ── Transacción: candado global + rollback restaurando una copia ──
  let cola = Promise.resolve();
  async function ejecutarEnTransaccion(fn) {
    const turnoAnterior = cola;
    let liberar;
    cola = new Promise((r) => (liberar = r));
    await turnoAnterior;
    const respaldo = structuredClone({
      solicitudes: estado.solicitudes,
      ofertas: estado.ofertas,
      busquedas: estado.busquedas,
      candidatos: estado.candidatos,
      eventos: estado.eventos,
    });
    try {
      return await fn({ tx: true });
    } catch (error) {
      Object.assign(estado, respaldo);
      throw error;
    } finally {
      liberar();
    }
  }

  // ── Equipo A ──
  const solicitudesPuerto = {
    async obtenerEstado(id) {
      await pausa();
      const s = estado.solicitudes.get(id);
      return s ? { estado: s.estado, conductorAsignadoId: s.conductorAsignadoId ?? null } : null;
    },
    async asignar({ solicitudId, conductorId }) {
      await pausa(); // latencia ANTES; comprobar y escribir van juntos (atómico, como la base)
      const s = estado.solicitudes.get(solicitudId);
      if (!s) return { resultado: R.SOLICITUD_INEXISTENTE };
      if (s.estado === EstadoSolicitud.BUSCANDO) {
        s.estado = EstadoSolicitud.ASIGNADA;
        s.conductorAsignadoId = conductorId;
        return { resultado: R.ASIGNADA };
      }
      if (s.estado === EstadoSolicitud.ASIGNADA) {
        return { resultado: s.conductorAsignadoId === conductorId ? R.ASIGNADA : R.YA_ASIGNADA };
      }
      if (s.estado === EstadoSolicitud.CANCELADA) return { resultado: R.SOLICITUD_CANCELADA };
      return { resultado: R.SOLICITUD_NO_BUSCANDO };
    },
    async marcarSinDisponibilidad({ solicitudId }) {
      await pausa();
      const s = estado.solicitudes.get(solicitudId);
      if (!s) return { aplicado: false, estadoActual: null };
      if (s.estado !== EstadoSolicitud.BUSCANDO) return { aplicado: false, estadoActual: s.estado };
      s.estado = EstadoSolicitud.SIN_DISPONIBILIDAD;
      return { aplicado: true, estadoActual: s.estado };
    },
  };

  // Lo que haría A al cancelar (en su propia transacción, condicional BUSCANDO -> CANCELADA).
  async function cancelarSolicitud(solicitudId) {
    return ejecutarEnTransaccion(async () => {
      await pausa();
      const s = estado.solicitudes.get(solicitudId);
      if (!s || s.estado !== EstadoSolicitud.BUSCANDO) return false;
      s.estado = EstadoSolicitud.CANCELADA;
      return true;
    });
  }

  // ── Equipo B ──
  const ofertasPuerto = {
    async obtenerPorId(id) {
      await pausa();
      return copia(estado.ofertas.get(id));
    },
    async aceptar({ ofertaId, conductorId, ahora }) {
      await pausa();
      const o = estado.ofertas.get(ofertaId);
      const ok =
        o &&
        o.estado === EstadoOferta.PENDIENTE &&
        o.conductorId === conductorId &&
        new Date(o.venceEn) > ahora;
      if (ok) o.estado = EstadoOferta.ACEPTADA;
      return { aceptada: Boolean(ok) };
    },
    async rechazar({ ofertaId, conductorId, ahora }) {
      await pausa();
      const o = estado.ofertas.get(ofertaId);
      const ok =
        o &&
        o.estado === EstadoOferta.PENDIENTE &&
        o.conductorId === conductorId &&
        new Date(o.venceEn) > ahora;
      if (ok) o.estado = EstadoOferta.RECHAZADA;
      return { rechazada: Boolean(ok) };
    },
    // Para el job de vencimientos: pendientes cuyo plazo ya pasó.
    async listarVencidas({ ahora, lote = 100 }) {
      await pausa();
      return [...estado.ofertas.values()]
        .filter((o) => o.estado === EstadoOferta.PENDIENTE && new Date(o.venceEn) <= ahora)
        .slice(0, lote)
        .map(({ ofertaId, solicitudId, conductorId }) => ({ ofertaId, solicitudId, conductorId }));
    },
    async vencer({ ofertaId, ahora }) {
      await pausa();
      const o = estado.ofertas.get(ofertaId);
      const ok = o && o.estado === EstadoOferta.PENDIENTE && new Date(o.venceEn) <= ahora;
      if (ok) o.estado = EstadoOferta.VENCIDA;
      return { vencida: Boolean(ok) };
    },
    async cancelarPendientesDeSolicitud({ solicitudId, exceptoOfertaId = null }) {
      await pausa();
      const canceladas = [];
      for (const o of estado.ofertas.values()) {
        if (o.solicitudId === solicitudId && o.estado === EstadoOferta.PENDIENTE && o.ofertaId !== exceptoOfertaId) {
          o.estado = EstadoOferta.CANCELADA;
          canceladas.push({ ofertaId: o.ofertaId, conductorId: o.conductorId });
        }
      }
      return canceladas;
    },
    async contarPendientes(solicitudId) {
      await pausa();
      // Igual que el repositorio real: solo cuentan las pendientes VIGENTES (venceEn > ahora).
      return [...estado.ofertas.values()].filter(
        (o) =>
          o.solicitudId === solicitudId &&
          o.estado === EstadoOferta.PENDIENTE &&
          new Date(o.venceEn) > reloj
      ).length;
    },
  };

  const busquedasPuerto = {
    async obtenerActiva(solicitudId) {
      await pausa();
      const b = estado.busquedas.get(solicitudId);
      return b && b.estado === EstadoBusqueda.ACTIVA ? copia(b) : null;
    },
    async cerrar({ solicitudId, estado: nuevo }) {
      await pausa();
      const b = estado.busquedas.get(solicitudId);
      if (!b || b.estado !== EstadoBusqueda.ACTIVA) return false;
      b.estado = nuevo;
      return true;
    },
  };

  const candidatosPuerto = {
    async guardar({ solicitudId, lista }) {
      for (const c of lista) {
        const clave = `${solicitudId}:${c.conductorId}`;
        if (!estado.candidatos.has(clave)) estado.candidatos.set(clave, { solicitudId, conductorId: c.conductorId, liberadoEn: null });
      }
    },
    async pendientesDeLiberar({ solicitudId, exceptoConductorId }) {
      return [...estado.candidatos.values()]
        .filter((c) => c.solicitudId === solicitudId && !c.liberadoEn && c.conductorId !== exceptoConductorId)
        .map((c) => c.conductorId);
    },
    async marcarLiberados({ solicitudId, conductorIds, ahora }) {
      let marcados = 0;
      for (const id of conductorIds) {
        const c = estado.candidatos.get(`${solicitudId}:${id}`);
        if (c && !c.liberadoEn) { c.liberadoEn = ahora ?? reloj; marcados += 1; }
      }
      return { marcados };
    },
  };

  const eventosPuerto = {
    async registrar(evento) {
      estado.eventos.push({ ...evento });
    },
  };

  // ── Infraestructura y avisos ──
  const cacheOfertas = {
    async eliminar(ids) {
      if (espias.fallar.cache) throw new Error("Redis caído");
      espias.cacheEliminado.push(...ids);
    },
  };
  const notificaciones = {
    async conductorAsignado(datos) {
      if (espias.fallar.conductorAsignado) throw new Error("M6 caído");
      espias.conductorAsignado.push(datos);
    },
    // Como el real: devuelve los conductores liberados; si M4 falla con alguno, el error trae los que sí salieron.
    async liberarConductores(lista) {
      if (espias.fallar.liberar) throw Object.assign(new Error("M4 caído"), { liberados: [] });
      const ok = lista.filter((i) => !espias.fallar.liberarIds.includes(i.conductorId));
      espias.liberados.push(...ok);
      if (ok.length < lista.length) {
        throw Object.assign(new Error("M4 falló con algunos"), { liberados: ok.map((i) => i.conductorId) });
      }
      return ok.map((i) => i.conductorId);
    },
  };

  const deps = {
    ejecutarEnTransaccion,
    solicitudes: solicitudesPuerto,
    ofertas: ofertasPuerto,
    busquedas: busquedasPuerto,
    candidatos: candidatosPuerto,
    eventos: eventosPuerto,
    cacheOfertas,
    notificaciones,
    reloj: () => reloj,
    logger: { error() {}, warn() {}, info() {} },
  };

  return {
    deps,
    estado,
    espias,
    cancelarSolicitud,
    fijarReloj: (nueva) => { reloj = nueva; },
  };
}

// Escenario típico: una solicitud en BUSCANDO con `n` ofertas pendientes (un conductor por oferta).
// `sinOferta` = cuántos candidatos más devolvió M4 que nunca recibieron oferta (también quedan reservados).
function escenarioConOfertas(n, { venceEn = new Date("2026-10-20T12:05:00Z"), candidatosRestantes = 3, sinOferta = 0 } = {}) {
  const solicitudId = "sol-1";
  const ofertas = Array.from({ length: n }, (_, i) => ({
    ofertaId: `of-${i + 1}`,
    solicitudId,
    conductorId: `cond-${i + 1}`,
    estado: EstadoOferta.PENDIENTE,
    venceEn,
  }));
  const candidatos = [
    ...ofertas.map((o) => ({ solicitudId, conductorId: o.conductorId })),
    ...Array.from({ length: sinOferta }, (_, i) => ({ solicitudId, conductorId: `cond-extra-${i + 1}` })),
  ];
  return crearMundo({
    solicitudes: [{ solicitudId, estado: EstadoSolicitud.BUSCANDO, conductorAsignadoId: null }],
    ofertas,
    candidatos,
    busquedas: [
      {
        busquedaId: "bus-1",
        solicitudId,
        estado: EstadoBusqueda.ACTIVA,
        venceEn: new Date("2026-10-20T12:10:00Z"),
        candidatosRestantes,
      },
    ],
  });
}

function barajar(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { crearMundo, escenarioConOfertas, barajar, pausa };
