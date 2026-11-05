// src/busqueda/ranking.js

// `clave` es el campo con la distancia ("distancia" por defecto; el servicio de búsqueda usa "distanciaM").
function ordenarCandidatosPorDistancia(candidatos, clave = "distancia") {
  // Ordena del más cercano al más lejano (menor distancia a mayor distancia)
  return candidatos.sort((a, b) => a[clave] - b[clave]);
}

module.exports = { ordenarCandidatosPorDistancia };
