// Job que marca como VENCIDAS las ofertas cuyo plazo terminó (RF-5.4, RNF-11).
//
// IMPORTANTE: este job NO es lo que impide aceptar una oferta vencida. Eso lo garantiza la
// condición `venceEn > ahora` dentro de la escritura de aceptar/rechazar. El job solo limpia:
// deja el estado coherente, libera a los conductores y detecta la búsqueda agotada.
//
// Seguro con varias instancias: `vencer` es condicional (PENDIENTE y vencida), así que solo
// una gana cada oferta y solo esa registra el evento y avisa. Una falla en una oferta no
// frena a las demás ni al siguiente ciclo.
const { TipoEvento } = require("../comun/estados");
const { MotivoLiberacion } = require("../asignacion/notificaciones");
const { liberarYMarcar } = require("../asignacion/liberacion");
const {
  RevertirTransaccion,
  conReintentoPorDeadlock,
  conTimeout,
  evaluarBusquedaAgotada,
  validarDependencias,
} = require("../asignacion");

function iniciarJobVencimientos({ deps, intervaloMs = 5000, lote = 100, logger }) {
  validarDependencias(deps);
  for (const metodo of ["listarVencidas", "vencer"]) {
    if (typeof deps.ofertas?.[metodo] !== "function") {
      throw new Error(`Faltan dependencias para el job de vencimientos: ofertas.${metodo}`);
    }
  }
  const log = logger ?? deps.logger;
  const reloj = deps.reloj ?? (() => new Date());
  const esperaAvisoMs = deps.timeoutAvisosMs ?? 3000;
  let corriendo = false;

  async function venceUna(oferta, ahora) {
    return conReintentoPorDeadlock(() =>
      deps
        .ejecutarEnTransaccion(async (tx) => {
          await deps.eventos.registrar(
            {
              solicitudId: oferta.solicitudId,
              tipo: TipoEvento.VENCIMIENTO,
              conductorId: oferta.conductorId,
              ofertaId: oferta.ofertaId,
              ocurridoEn: ahora,
            },
            tx
          );
          const r = await deps.ofertas.vencer({ ofertaId: oferta.ofertaId, ahora }, tx);
          if (!r.vencida) throw new RevertirTransaccion("YA_NO_PENDIENTE");
          return true;
        })
        .catch((error) => {
          if (error instanceof RevertirTransaccion) return false;
          throw error;
        })
    );
  }

  // Un ciclo: devuelve un resumen (lo usan los tests y la demo).
  async function ciclo() {
    if (corriendo) return { omitido: true };
    corriendo = true;
    const resumen = { vencidas: 0, errores: 0, solicitudesEvaluadas: 0 };
    try {
      const ahora = reloj();
      const candidatas = await deps.ofertas.listarVencidas({ ahora, lote });
      const solicitudes = new Set();

      for (const oferta of candidatas) {
        try {
          if (!(await venceUna(oferta, ahora))) continue; // otro la resolvió primero
          resumen.vencidas += 1;
          solicitudes.add(oferta.solicitudId);
          await conTimeout(Promise.resolve().then(() => deps.cacheOfertas.eliminar([oferta.ofertaId])), esperaAvisoMs)
            .catch((e) => log?.error({ err: e, ofertaId: oferta.ofertaId }, "falló la baja en caché"));
          await conTimeout(
            Promise.resolve().then(() =>
              liberarYMarcar(
                {
                  solicitudId: oferta.solicitudId,
                  items: [
                    {
                      solicitudId: oferta.solicitudId,
                      conductorId: oferta.conductorId,
                      ofertaId: oferta.ofertaId,
                      motivo: MotivoLiberacion.OFERTA_VENCIDA,
                    },
                  ],
                },
                deps
              )
            ),
            esperaAvisoMs
          ).catch((e) => log?.error({ err: e, solicitudId: oferta.solicitudId }, "falló el aviso de vencimiento"));
        } catch (error) {
          resumen.errores += 1;
          log?.error({ err: error, ofertaId: oferta.ofertaId }, "falló el vencimiento de una oferta");
        }
      }

      // Una evaluación por solicitud (no una por oferta): la señal sale una sola vez.
      for (const solicitudId of solicitudes) {
        try {
          await evaluarBusquedaAgotada({ solicitudId }, deps);
          resumen.solicitudesEvaluadas += 1;
        } catch (error) {
          resumen.errores += 1;
          log?.error({ err: error, solicitudId }, "falló la evaluación de búsqueda agotada");
        }
      }
    } catch (error) {
      resumen.errores += 1;
      log?.error({ err: error }, "falló un ciclo del job de vencimientos");
    } finally {
      corriendo = false;
    }
    return resumen;
  }

  const temporizador = setInterval(ciclo, intervaloMs);
  temporizador.unref?.(); // el job no debe impedir que el proceso termine
  return { ciclo, detener: () => clearInterval(temporizador) };
}

module.exports = { iniciarJobVencimientos };
