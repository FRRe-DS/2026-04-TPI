// Puerto `candidatos` sobre Prisma: la lista que devolvió M4 para cada solicitud.
//
// M4 no reserva la lista: M5 reserva de a un conductor antes de ofertarle (reservadoEn). Hay que recordar
// a quiénes se devolvió, a quiénes reservó M5 (reservadoEn) y quiénes ya salieron de la reserva
// (liberadoEn), para liberar solo a los reservados que faltan al cerrar la solicitud. Liberar a uno que
// M5 no reservó le sacaría el bloqueo a otra solicitud.
//
// NO se probó contra MySQL real (solo contra tests/soporte/prismaFalso.js). Los modelos están en
// prisma/modelos-m5.prisma (Candidato) y hay que pegarlos en el schema de bd/.
//
// Todas las funciones aceptan `tx` (cliente de la transacción) como último parámetro.
function crearRepositorioCandidatos(prisma, { reloj = () => new Date() } = {}) {
  const cliente = (tx) => tx ?? prisma;

  return {
    // Idempotente: repetir (solicitudId, ronda, conductorId) no duplica (skipDuplicates).
    async guardar({ solicitudId, ronda = 1, lista, ahora = reloj() }, tx) {
      if (!Array.isArray(lista) || lista.length === 0) return { guardados: 0 };
      const r = await cliente(tx).candidato.createMany({
        data: lista.map((c, posicion) => ({
          solicitudId,
          ronda,
          conductorId: c.conductorId,
          distanciaKm: c.distanciaKm,
          tipoVehiculo: String(c.tipoVehiculo),
          posicion,
          obtenidoEn: ahora,
        })),
        skipDuplicates: true,
      });
      return { guardados: r.count };
    },

    // Despacho por tandas: los que todavía no recibieron oferta, del más cercano al más lejano.
    // Quedan fuera los ya reservados (con oferta), los omitidos por conflicto en M4 y los liberados.
    pendientesDeOfertar: ({ solicitudId, ronda = 1 }, tx) =>
      cliente(tx).candidato.findMany({
        where: { solicitudId, ronda, reservadoEn: null, omitidoEn: null, liberadoEn: null },
        orderBy: { posicion: "asc" },
        select: { conductorId: true, distanciaKm: true, tipoVehiculo: true },
      }),

    // M4 informó conflicto (otra solicitud lo reservó antes): no se les vuelve a ofertar.
    async marcarOmitidos({ solicitudId, ronda = 1, conductorIds, ahora = reloj() }, tx) {
      if (!conductorIds?.length) return { marcados: 0 };
      const r = await cliente(tx).candidato.updateMany({
        where: { solicitudId, ronda, conductorId: { in: conductorIds }, reservadoEn: null, omitidoEn: null },
        data: { omitidoEn: ahora },
      });
      return { marcados: r.count };
    },

    // M4 aceptó reservar al conductor (bloqueo temporal). Condicional: marca una sola vez.
    async marcarReservado({ solicitudId, ronda = 1, conductorId, ahora = reloj() }, tx) {
      const r = await cliente(tx).candidato.updateMany({
        where: { solicitudId, ronda, conductorId, reservadoEn: null },
        data: { reservadoEn: ahora },
      });
      return { marcados: r.count };
    },

    // Conductores de TODAS las rondas que M5 reservó en M4 y siguen sin liberar, en orden de la lista.
    async pendientesDeLiberar({ solicitudId, exceptoConductorId }, tx) {
      const filas = await cliente(tx).candidato.findMany({
        where: {
          solicitudId,
          reservadoEn: { not: null },
          liberadoEn: null,
          ...(exceptoConductorId ? { NOT: { conductorId: exceptoConductorId } } : {}),
        },
        orderBy: [{ ronda: "asc" }, { posicion: "asc" }],
        select: { conductorId: true },
      });
      return [...new Set(filas.map((f) => f.conductorId))];
    },

    // Condicional: solo marca a los que seguían sin liberar.
    async marcarLiberados({ solicitudId, conductorIds, ahora = reloj() }, tx) {
      if (!conductorIds?.length) return { marcados: 0 };
      const r = await cliente(tx).candidato.updateMany({
        where: { solicitudId, conductorId: { in: conductorIds }, liberadoEn: null },
        data: { liberadoEn: ahora },
      });
      return { marcados: r.count };
    },
  };
}

module.exports = { crearRepositorioCandidatos };
