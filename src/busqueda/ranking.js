// src/busqueda/ranking.js

function ordenarCandidatosPorDistancia(candidatos) {
  // Ordena del más cercano al más lejano (menor distancia a mayor distancia)
  return candidatos.sort((a, b) => a.distancia - b.distancia);
}

module.exports = { ordenarCandidatosPorDistancia };