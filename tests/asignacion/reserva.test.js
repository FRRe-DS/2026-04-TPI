const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { reservarConductores, procesarAceptacion } = require("../../src/asignacion");
const { crearMundo } = require("../soporte/fakes");
const { EstadoSolicitud, EstadoBusqueda } = require("../../src/comun/estados");

// Mundo con una solicitud buscando y la lista de M4 guardada pero SIN reservar (como sale de la búsqueda).
function mundoConLista(ids) {
  const m = crearMundo({
    solicitudes: [{ solicitudId: "sol-1", estado: EstadoSolicitud.BUSCANDO, conductorAsignadoId: null }],
    busquedas: [{ busquedaId: "bus-1", solicitudId: "sol-1", estado: EstadoBusqueda.ACTIVA, venceEn: new Date("2026-10-20T12:10:00Z"), candidatosRestantes: 3 }],
  });
  return { m, lista: ids.map((conductorId, i) => ({ conductorId, distanciaM: 100 * (i + 1), tipoVehiculo: "AUTO" })) };
}
const reservadosEnBD = (m) => [...m.estado.candidatos.values()].filter((c) => c.reservadoEn && !c.liberadoEn).map((c) => c.conductorId).sort();

describe("reserva en M4, de a un conductor y antes de ofertar", () => {
  test("reserva en orden de cercanía y marca solo a los que M4 aceptó", async () => {
    const { m, lista } = mundoConLista(["c1", "c2", "c3"]);
    await m.deps.candidatos.guardar({ solicitudId: "sol-1", lista });
    const r = await reservarConductores({ solicitudId: "sol-1", candidatos: lista }, m.deps);
    assert.deepEqual(r.reservados.map((c) => c.conductorId), ["c1", "c2", "c3"]);
    assert.deepEqual(m.espias.reservados.map((x) => x.conductorId), ["c1", "c2", "c3"]);
    assert.deepEqual(reservadosEnBD(m), ["c1", "c2", "c3"]);
  });

  test("si M4 informa conflicto, se salta al siguiente y el que no se reservó queda sin marcar", async () => {
    const { m, lista } = mundoConLista(["c1", "c2", "c3"]);
    m.espias.conflictos.push("c1");
    await m.deps.candidatos.guardar({ solicitudId: "sol-1", lista });
    const r = await reservarConductores({ solicitudId: "sol-1", candidatos: lista, cantidad: 2 }, m.deps);
    assert.deepEqual(r.reservados.map((c) => c.conductorId), ["c2", "c3"]);
    assert.deepEqual(r.conflictos, ["c1"]);
    assert.deepEqual(reservadosEnBD(m), ["c2", "c3"]);
  });

  test("se deja de reservar al llegar a la cantidad pedida", async () => {
    const { m, lista } = mundoConLista(["c1", "c2", "c3"]);
    await m.deps.candidatos.guardar({ solicitudId: "sol-1", lista });
    const r = await reservarConductores({ solicitudId: "sol-1", candidatos: lista, cantidad: 1 }, m.deps);
    assert.deepEqual(r.reservados.map((c) => c.conductorId), ["c1"]);
    assert.deepEqual(m.espias.reservados.map((x) => x.conductorId), ["c1"]);
  });

  test("si M4 falla con uno, se informa en fallidos y se sigue con los demás", async () => {
    const { m, lista } = mundoConLista(["c1", "c2"]);
    m.espias.fallar.reservarIds.push("c1");
    await m.deps.candidatos.guardar({ solicitudId: "sol-1", lista });
    const r = await reservarConductores({ solicitudId: "sol-1", candidatos: lista }, m.deps);
    assert.deepEqual(r.fallidos, ["c1"]);
    assert.deepEqual(r.reservados.map((c) => c.conductorId), ["c2"]);
    assert.deepEqual(reservadosEnBD(m), ["c2"]);
  });

  test("al cerrar la solicitud NO se libera a quien M5 no reservó (podría ser de otra solicitud)", async () => {
    const { m, lista } = mundoConLista(["c1", "c2", "c3"]);
    m.espias.conflictos.push("c3"); // c3 lo tiene otra solicitud
    await m.deps.candidatos.guardar({ solicitudId: "sol-1", lista });
    await reservarConductores({ solicitudId: "sol-1", candidatos: lista }, m.deps);
    m.estado.ofertas.set("of-1", { ofertaId: "of-1", solicitudId: "sol-1", conductorId: "c1", estado: "pendiente", venceEn: new Date("2026-10-20T12:05:00Z") });
    m.estado.ofertas.set("of-2", { ofertaId: "of-2", solicitudId: "sol-1", conductorId: "c2", estado: "pendiente", venceEn: new Date("2026-10-20T12:05:00Z") });

    await procesarAceptacion({ ofertaId: "of-1", conductorId: "c1" }, m.deps);
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId).sort(), ["c1", "c2"], "c3 nunca fue reservado por esta solicitud: no se libera");
  });
});
