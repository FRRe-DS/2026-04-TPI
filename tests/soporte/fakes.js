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
const { ResultadoAsignacion: R } = require("../../src/asignacion/resultados");

const pausa = (max = 3) => new Promise((r) => setTimeout(r, Math.random() * max));
const copia = (x) => (x ? structuredClone(x) : null);

function crearMundo({ solicitudes = [], ofertas = [], busquedas = [], ahora = new Date("2026-10-20T12:00:00Z") } = {}) {
  const estado = {
    solicitudes: new Map(solicitudes.map((s) => [s.solicitudId, { ...s }])),
    ofertas: new Map(ofertas.map((o) => [o.ofertaId, { ...o }])),
    busquedas: new Map(busquedas.map((b) => [b.solicitudId, { ...b }])),
    eventos: [],
  };
  const espias = {
    cacheEliminado: [],
    conductorAsignado: [],
    liberados: [],
    fallar: { cache: false, conductorAsignado: false, liberar: false },
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
      return [...estado.ofertas.values()].filter(
        (o) => o.solicitudId === solicitudId && o.estado === EstadoOferta.PENDIENTE
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
    async liberarConductores(lista) {
      if (espias.fallar.liberar) throw new Error("M4 caído");
      espias.liberados.push(...lista);
    },
  };

  const deps = {
    ejecutarEnTransaccion,
    solicitudes: solicitudesPuerto,
    ofertas: ofertasPuerto,
    busquedas: busquedasPuerto,
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
function escenarioConOfertas(n, { venceEn = new Date("2026-10-20T12:05:00Z"), candidatosRestantes = 3 } = {}) {
  const solicitudId = "sol-1";
  const ofertas = Array.from({ length: n }, (_, i) => ({
    ofertaId: `of-${i + 1}`,
    solicitudId,
    conductorId: `cond-${i + 1}`,
    estado: EstadoOferta.PENDIENTE,
    venceEn,
  }));
  return crearMundo({
    solicitudes: [{ solicitudId, estado: EstadoSolicitud.BUSCANDO, conductorAsignadoId: null }],
    ofertas,
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
