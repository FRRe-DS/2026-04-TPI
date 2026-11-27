// src/busqueda/ranking.test.js
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { ordenarCandidatosPorDistancia } = require("./ranking");

describe("ordenarCandidatosPorDistancia", () => {
  test("Debería ordenar a los conductores del más cercano al más lejano", () => {
    const conductoresDesordenados = [
      { id: 1, distancia: 5.5 },
      { id: 2, distancia: 1.2 },
      { id: 3, distancia: 3.0 },
    ];

    const resultado = ordenarCandidatosPorDistancia(conductoresDesordenados);

    assert.equal(resultado[0].id, 2);
    assert.equal(resultado[1].id, 3);
    assert.equal(resultado[2].id, 1);
  });

  test("Debería permitir ordenar por una clave de distancia personalizada (ej. distanciaM)", () => {
    const candidatos = [
      { conductorId: "c-lejos", distanciaM: 1450 },
      { conductorId: "c-cerca", distanciaM: 220 },
      { conductorId: "c-medio", distanciaM: 680 },
    ];

    const resultado = ordenarCandidatosPorDistancia([...candidatos], "distanciaM");

    assert.deepEqual(
      resultado.map((c) => c.conductorId),
      ["c-cerca", "c-medio", "c-lejos"]
    );
  });
});
