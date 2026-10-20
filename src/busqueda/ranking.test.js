// src/busqueda/ranking.test.js
const { ordenarCandidatosPorDistancia } = require('./ranking');

test('Debería ordenar a los conductores del más cercano al más lejano', () => {
  // Lista de conductores desordenados de prueba
  const conductoresDesordenados = [
    { id: 1, distancia: 5.5 },
    { id: 2, distancia: 1.2 },
    { id: 3, distancia: 3.0 }
  ];

  // Ejecutamos la función de ordenamiento
  const resultado = ordenarCandidatosPorDistancia(conductoresDesordenados);

  // Verificamos que el primero sea el de menor distancia (1.2)
  expect(resultado[0].id).toBe(2);
  // Que el segundo sea el de 3.0
  expect(resultado[1].id).toBe(3);
  // Que el último sea el de 5.5
  expect(resultado[2].id).toBe(1);
});