// Cliente Prisma FALSO, en memoria, solo para probar src/respuesta/repositorioOfertas.js.
// Entiende los filtros que usa el repositorio: igualdad, { gt }, { lte }, { in } y NOT.
// LIMITACIÓN: no modela transacciones reales ni bloqueos; solo verifica que los WHERE del
// repositorio expresen la regla de negocio. No reemplaza una prueba contra MySQL.
function coincide(fila, where = {}) {
  return Object.entries(where).every(([campo, condicion]) => {
    if (campo === "NOT") return !coincide(fila, condicion);
    const valor = fila[campo];
    if (condicion !== null && typeof condicion === "object" && !(condicion instanceof Date)) {
      if ("gt" in condicion && !(valor > condicion.gt)) return false;
      if ("lte" in condicion && !(valor <= condicion.lte)) return false;
      if ("in" in condicion && !condicion.in.includes(valor)) return false;
      return true;
    }
    return valor === condicion;
  });
}

function elegir(fila, select) {
  if (!select) return { ...fila };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, fila[k]]));
}

function crearPrismaFalso(ofertas = [], candidatos = []) {
  const filas = ofertas.map((o) => ({ respondidaEn: null, ...o }));
  const filasCandidatos = candidatos.map((c) => ({ ronda: 1, liberadoEn: null, ...c }));
  const llamadas = { transaccion: [] };
  const oferta = {
    async findUnique({ where, select }) {
      const f = filas.find((x) => coincide(x, where));
      return f ? elegir(f, select) : null;
    },
    async findMany({ where, orderBy, take, select } = {}) {
      let r = filas.filter((x) => coincide(x, where));
      if (orderBy?.venceEn === "asc") r = [...r].sort((a, b) => a.venceEn - b.venceEn);
      if (take) r = r.slice(0, take);
      return r.map((f) => elegir(f, select));
    },
    async updateMany({ where, data }) {
      const r = filas.filter((x) => coincide(x, where));
      for (const f of r) Object.assign(f, data);
      return { count: r.length };
    },
    async count({ where }) {
      return filas.filter((x) => coincide(x, where)).length;
    },
  };
  const candidato = {
    async createMany({ data, skipDuplicates }) {
      let creados = 0;
      for (const d of data) {
        const repetido = filasCandidatos.some(
          (f) => f.solicitudId === d.solicitudId && f.ronda === d.ronda && f.conductorId === d.conductorId
        );
        if (repetido && skipDuplicates) continue;
        if (repetido) throw new Error("clave duplicada");
        filasCandidatos.push({ liberadoEn: null, ...d });
        creados += 1;
      }
      return { count: creados };
    },
    async findMany({ where, orderBy, select } = {}) {
      let r = filasCandidatos.filter((x) => coincide(x, where));
      if (orderBy) {
        const claves = [].concat(orderBy).map((o) => Object.entries(o)[0]);
        r = [...r].sort((a, b) => {
          for (const [campo, sentido] of claves) {
            if (a[campo] !== b[campo]) return (a[campo] < b[campo] ? -1 : 1) * (sentido === "desc" ? -1 : 1);
          }
          return 0;
        });
      }
      return r.map((f) => elegir(f, select));
    },
    async updateMany({ where, data }) {
      const r = filasCandidatos.filter((x) => coincide(x, where));
      for (const f of r) Object.assign(f, data);
      return { count: r.length };
    },
  };
  return {
    oferta,
    candidato,
    filas,
    filasCandidatos,
    llamadas,
    async $transaction(fn, opciones) {
      llamadas.transaccion.push(opciones);
      return fn(this);
    },
  };
}

module.exports = { crearPrismaFalso };
