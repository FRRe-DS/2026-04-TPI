// Job que manda las tandas siguientes (RF-5.4): cada pocos segundos busca las búsquedas activas cuya
// próxima tanda ya toca (proximaTandaEn <= ahora) y envía la tanda.
//
// Usar la base como reloj (en vez de un setTimeout por búsqueda) hace que un reinicio no pierda tandas
// y que varias instancias convivan: enviarTanda reclama cada turno con una escritura condicional,
// así que si dos instancias ven la misma búsqueda solo una manda la tanda.
const { enviarTanda, validarDependenciasDespacho } = require("./despacho");

function iniciarJobTandas({ deps, intervaloMs = 2000, lote = 50, logger }) {
  validarDependenciasDespacho(deps);
  const log = logger ?? deps.logger;
  const reloj = deps.reloj ?? (() => new Date());
  let corriendo = false;

  // Un ciclo: devuelve un resumen (lo usan los tests y la demo).
  async function ciclo() {
    if (corriendo) return { omitido: true };
    corriendo = true;
    const resumen = { revisadas: 0, enviadas: 0, errores: 0 };
    try {
      const debidas = await deps.busquedas.listarTandasVencidas({ ahora: reloj(), lote });
      // De a una: cada tanda hace llamadas a M4 y a M3 y no conviene dispararlas todas juntas.
      for (const { solicitudId } of debidas) {
        try {
          const r = await enviarTanda({ solicitudId }, deps);
          resumen.revisadas += 1;
          if (r.resultado === "enviada" || r.resultado === "enviada_con_error") resumen.enviadas += 1;
        } catch (error) {
          resumen.errores += 1;
          log?.error({ err: error, solicitudId }, "falló el envío de una tanda de ofertas");
        }
      }
    } catch (error) {
      resumen.errores += 1;
      log?.error({ err: error }, "falló un ciclo del job de tandas");
    } finally {
      corriendo = false;
    }
    return resumen;
  }

  const temporizador = setInterval(ciclo, intervaloMs);
  temporizador.unref?.(); // el job no debe impedir que el proceso termine
  return { ciclo, detener: () => clearInterval(temporizador) };
}

module.exports = { iniciarJobTandas };
