const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { procesarAceptacion, ResultadoAsignacion: R, procesarCancelacionSolicitud } = require("../../src/asignacion");
const { EstadoSolicitud, EstadoOferta, EstadoBusqueda, TipoEvento } = require("../../src/comun/estados");
const { escenarioConOfertas, barajar, pausa } = require("../soporte/fakes");

const contar = (arr, valor) => arr.filter((x) => x === valor).length;

describe("Aceptación simple", () => {
  test("asigna, acepta la oferta, cancela las hermanas, cierra la búsqueda y avisa una vez", async () => {
    const m = escenarioConOfertas(3);
    const r = await procesarAceptacion({ ofertaId: "of-2", conductorId: "cond-2" }, m.deps);

    assert.equal(r.resultado, R.ASIGNADA);
    assert.equal(r.repetida, false);
    assert.deepEqual(r.avisosFallidos, []);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.ASIGNADA);
    assert.equal(m.estado.solicitudes.get("sol-1").conductorAsignadoId, "cond-2");
    assert.equal(m.estado.ofertas.get("of-2").estado, EstadoOferta.ACEPTADA);
    assert.equal(m.estado.ofertas.get("of-1").estado, EstadoOferta.CANCELADA);
    assert.equal(m.estado.ofertas.get("of-3").estado, EstadoOferta.CANCELADA);
    assert.equal(m.estado.busquedas.get("sol-1").estado, EstadoBusqueda.FINALIZADA);

    // Trazabilidad: 1 aceptación + 2 cancelaciones.
    assert.equal(m.estado.eventos.filter((e) => e.tipo === TipoEvento.ACEPTACION).length, 1);
    assert.equal(m.estado.eventos.filter((e) => e.tipo === TipoEvento.CANCELACION).length, 2);

    // Avisos externos: M6 una vez, M4 libera a los 2 perdedores, Redis limpia las 3 ofertas.
    assert.equal(m.espias.conductorAsignado.length, 1);
    assert.deepEqual(m.espias.liberados.map((l) => l.conductorId).sort(), ["cond-1", "cond-3"]);
    assert.equal(m.espias.cacheEliminado.length, 3);
  });

  test("oferta inexistente y conductor que no es el de la oferta", async () => {
    const m = escenarioConOfertas(1);
    assert.equal((await procesarAceptacion({ ofertaId: "nada", conductorId: "cond-1" }, m.deps)).resultado, R.OFERTA_INEXISTENTE);
    assert.equal((await procesarAceptacion({ ofertaId: "of-1", conductorId: "otro" }, m.deps)).resultado, R.CONDUCTOR_NO_AUTORIZADO);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.BUSCANDO);
  });

  test("oferta vencida: no cambia nada", async () => {
    const m = escenarioConOfertas(1);
    m.fijarReloj(new Date("2026-10-20T12:06:00Z")); // la oferta vencía 12:05
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, R.OFERTA_NO_VIGENTE);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.BUSCANDO);
    assert.equal(m.estado.ofertas.get("of-1").estado, EstadoOferta.PENDIENTE);
    assert.equal(m.espias.conductorAsignado.length, 0);
  });
});

describe("Asignación única bajo concurrencia (RF-5.6, RNF-08, RNF-07)", () => {
  test("N conductores aceptan a la vez: gana exactamente uno (50 repeticiones)", async () => {
    for (let vuelta = 0; vuelta < 50; vuelta++) {
      const N = 10;
      const m = escenarioConOfertas(N);
      const pedidos = barajar(Array.from({ length: N }, (_, i) => i + 1));

      const resultados = await Promise.all(
        pedidos.map(async (i) => {
          await pausa(5); // arribos en distinto orden
          return procesarAceptacion({ ofertaId: `of-${i}`, conductorId: `cond-${i}` }, m.deps);
        })
      );

      const lista = resultados.map((r) => r.resultado);
      assert.equal(contar(lista, R.ASIGNADA), 1, `vuelta ${vuelta}: debe haber un único ganador`);
      assert.equal(contar(lista, R.YA_ASIGNADA), N - 1, `vuelta ${vuelta}: el resto debe recibir YA_ASIGNADA`);

      const ganador = resultados.find((r) => r.resultado === R.ASIGNADA).conductorId;
      assert.equal(m.estado.solicitudes.get("sol-1").conductorAsignadoId, ganador);

      // Consistencia entre tablas: una sola oferta aceptada, el resto cancelada.
      const ofertas = [...m.estado.ofertas.values()];
      assert.equal(ofertas.filter((o) => o.estado === EstadoOferta.ACEPTADA).length, 1);
      assert.equal(ofertas.filter((o) => o.estado === EstadoOferta.CANCELADA).length, N - 1);

      // El aviso a M6 sale una sola vez, con el ganador.
      assert.equal(m.espias.conductorAsignado.length, 1);
      assert.equal(m.espias.conductorAsignado[0].conductorId, ganador);
    }
  });

  test("SANIDAD: una implementación ingenua (leer y después escribir) SÍ duplica la asignación", async () => {
    // Demuestra que las pruebas detectan el problema que la escritura condicional evita.
    const m = escenarioConOfertas(5);
    const estadoSol = m.estado.solicitudes.get("sol-1");
    const ganadores = [];
    async function asignarIngenuo(conductorId) {
      if (estadoSol.estado === EstadoSolicitud.BUSCANDO) { // 1) leo
        await pausa(2);                                     // (otro request se cuela acá)
        estadoSol.estado = EstadoSolicitud.ASIGNADA;        // 2) escribo
        estadoSol.conductorAsignadoId = conductorId;
        ganadores.push(conductorId);
      }
    }
    await Promise.all([1, 2, 3, 4, 5].map((i) => asignarIngenuo(`cond-${i}`)));
    assert.ok(ganadores.length > 1, "la versión ingenua debería haber asignado a más de uno");
  });

  test("el mismo conductor envía su aceptación dos veces a la vez: ambas OK, un solo aviso", async () => {
    const m = escenarioConOfertas(3);
    const [a, b] = await Promise.all([
      procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps),
      procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps),
    ]);
    assert.equal(a.resultado, R.ASIGNADA);
    assert.equal(b.resultado, R.ASIGNADA);
    assert.equal([a, b].filter((r) => r.repetida).length, 1);
    assert.equal(m.espias.conductorAsignado.length, 1);
  });
});

describe("Idempotencia (RNF-09)", () => {
  test("repetir la aceptación después de ganar devuelve el mismo éxito sin repetir avisos", async () => {
    const m = escenarioConOfertas(2);
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    const otra = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(otra.resultado, R.ASIGNADA);
    assert.equal(otra.repetida, true);
    assert.equal(m.espias.conductorAsignado.length, 1);
    assert.equal(m.espias.liberados.length, 1);
  });

  test("un conductor que llega tarde recibe YA_ASIGNADA (no 'oferta vencida')", async () => {
    const m = escenarioConOfertas(2);
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    const tarde = await procesarAceptacion({ ofertaId: "of-2", conductorId: "cond-2" }, m.deps);
    assert.equal(tarde.resultado, R.YA_ASIGNADA);
  });
});

describe("Aceptación contra cancelación (RNF-08)", () => {
  test("si el cliente cancela primero, el conductor recibe SOLICITUD_CANCELADA y todo queda intacto", async () => {
    const m = escenarioConOfertas(1);
    assert.equal(await m.cancelarSolicitud("sol-1"), true);
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, R.SOLICITUD_CANCELADA);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.CANCELADA);
    assert.equal(m.estado.ofertas.get("of-1").estado, EstadoOferta.PENDIENTE);
    assert.equal(m.espias.conductorAsignado.length, 0);
  });

  test("si el conductor gana primero, la cancelación del cliente no se aplica", async () => {
    const m = escenarioConOfertas(1);
    await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(await m.cancelarSolicitud("sol-1"), false);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.ASIGNADA);
  });

  test("carrera real: aceptar y cancelar a la vez dejan SIEMPRE un estado consistente (100 repeticiones)", async () => {
    for (let vuelta = 0; vuelta < 100; vuelta++) {
      const m = escenarioConOfertas(1);
      const tareas = [
        async () => { await pausa(4); return ["acepta", await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps)]; },
        async () => { await pausa(4); return ["cancela", await m.cancelarSolicitud("sol-1")]; },
      ];
      const [r1, r2] = await Promise.all(barajar(tareas).map((t) => t()));
      const porNombre = Object.fromEntries([r1, r2]);
      const sol = m.estado.solicitudes.get("sol-1");

      if (porNombre.cancela === true) {
        assert.equal(sol.estado, EstadoSolicitud.CANCELADA);
        assert.equal(porNombre.acepta.resultado, R.SOLICITUD_CANCELADA);
        assert.equal(m.estado.ofertas.get("of-1").estado, EstadoOferta.PENDIENTE);
      } else {
        assert.equal(sol.estado, EstadoSolicitud.ASIGNADA);
        assert.equal(porNombre.acepta.resultado, R.ASIGNADA);
      }
    }
  });

  test("al cancelar el cliente, B anula las ofertas pendientes, cierra la búsqueda y libera conductores", async () => {
    const m = escenarioConOfertas(3);
    await m.cancelarSolicitud("sol-1");
    const r = await procesarCancelacionSolicitud({ solicitudId: "sol-1" }, m.deps);
    assert.equal(r.ofertasCanceladas.length, 3);
    assert.equal(m.estado.busquedas.get("sol-1").estado, EstadoBusqueda.FINALIZADA);
    assert.equal(m.espias.liberados.length, 3);
    assert.equal(m.espias.cacheEliminado.length, 3);
  });
});

describe("Atomicidad (todo o nada)", () => {
  test("si la oferta vence JUSTO después de asignar, se deshace también la asignación", async () => {
    const m = escenarioConOfertas(1);
    const aceptarOriginal = m.deps.ofertas.aceptar;
    m.deps.ofertas.aceptar = async () => ({ aceptada: false }); // simula vencimiento en el medio
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, R.OFERTA_NO_VIGENTE);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.BUSCANDO, "la solicitud debe volver a BUSCANDO");
    assert.equal(m.estado.solicitudes.get("sol-1").conductorAsignadoId, null);
    assert.equal(m.estado.eventos.length, 0);
    m.deps.ofertas.aceptar = aceptarOriginal;
  });

  test("un error inesperado a mitad de la transacción deja todo como estaba", async () => {
    const m = escenarioConOfertas(2);
    m.deps.busquedas.cerrar = async () => { throw new Error("falla de base de datos"); };
    await assert.rejects(() => procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps), /falla de base de datos/);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.BUSCANDO);
    assert.equal(m.estado.ofertas.get("of-1").estado, EstadoOferta.PENDIENTE);
    assert.equal(m.estado.ofertas.get("of-2").estado, EstadoOferta.PENDIENTE);
    assert.equal(m.espias.conductorAsignado.length, 0);
  });

  test("un deadlock se reintenta y termina bien", async () => {
    const m = escenarioConOfertas(1);
    const original = m.deps.ejecutarEnTransaccion;
    let intentos = 0;
    m.deps.ejecutarEnTransaccion = async (fn) => {
      intentos += 1;
      if (intentos === 1) { const e = new Error("deadlock"); e.code = "P2034"; throw e; }
      return original(fn);
    };
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, R.ASIGNADA);
    assert.equal(intentos, 2);
  });
});

describe("Avisos externos (RNF-13)", () => {
  test("si M6/M4/Redis fallan, la asignación igual vale y se informa qué avisos fallaron", async () => {
    const m = escenarioConOfertas(2);
    m.espias.fallar.conductorAsignado = true;
    m.espias.fallar.liberar = true;
    m.espias.fallar.cache = true;
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, R.ASIGNADA);
    assert.deepEqual(r.avisosFallidos.sort(), ["cacheOfertas", "conductorAsignado", "liberarConductores"]);
    assert.equal(m.estado.solicitudes.get("sol-1").estado, EstadoSolicitud.ASIGNADA);
  });

  test("un aviso que se cuelga no bloquea la respuesta (timeout)", async () => {
    const m = escenarioConOfertas(1);
    m.deps.timeoutAvisosMs = 50;
    m.deps.notificaciones.conductorAsignado = () => new Promise(() => {}); // nunca responde
    const inicio = Date.now();
    const r = await procesarAceptacion({ ofertaId: "of-1", conductorId: "cond-1" }, m.deps);
    assert.equal(r.resultado, R.ASIGNADA);
    assert.deepEqual(r.avisosFallidos, ["conductorAsignado"]);
    assert.ok(Date.now() - inicio < 1000);
  });
});

describe("Cableado", () => {
  test("avisa claramente si falta una dependencia", async () => {
    await assert.rejects(() => procesarAceptacion({ ofertaId: "x", conductorId: "y" }, {}), /Faltan dependencias/);
  });
});
