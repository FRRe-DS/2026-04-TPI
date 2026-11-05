// Puerto `candidatos` sobre Prisma: la lista que devolvió M4 para cada solicitud.
//
// M4 reserva a TODOS los conductores de la lista, así que hay que recordar a quiénes se devolvió y
// quiénes ya salieron de la reserva (liberadoEn), para liberar solo a los que faltan al cerrar la solicitud.
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
          distanciaM: c.distanciaM,
          tipoVehiculo: String(c.tipoVehiculo),
          posicion,
          obtenidoEn: ahora,
        })),
        skipDuplicates: true,
      });
      return { guardados: r.count };
    },

    // Conductores de TODAS las rondas que siguen reservados en M4 (sin liberar), en orden de la lista.
    async pendientesDeLiberar({ solicitudId, exceptoConductorId }, tx) {
      const filas = await cliente(tx).candidato.findMany({
        where: {
          solicitudId,
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
