const ClienteM3M4 = require('../clientes/ClienteM3M4');
const clienteExterno = new ClienteM3M4();

async function buscarYRankearCandidatos(datosSolicitud) {
  try {
    // 1. Consultar a M4 y M3 usando nuestro cliente
    const datosM4 = await clienteExterno.consultarM4(datosSolicitud);
    
    // Suponiendo que M4 nos devuelve una lista de candidatos iniciales
    const candidatosCrudos = datosM4.candidatos || [];

    // 2. FILTRADO (RF-5.3): proximidad, habilitación y tipo de vehículo
    const candidatosFiltrados = candidatosCrudos.filter(conductor => {
      const cumpleProximidad = conductor.distancia <= datosSolicitud.radioMaximo;
      const estaHabilitado = conductor.habilitado === true;
      const cumpleVehiculo = conductor.tipoVehiculo === datosSolicitud.tipoVehiculoRequerido;

      return cumpleProximidad && estaHabilitado && cumpleVehiculo;
    });

    // 3. RANKING: Ordenar los candidatos (por ejemplo, del más cercano al más lejano)
    const candidatosOrdenados = candidatosFiltrados.sort((a, b) => a.distancia - b.distancia);

    return candidatosOrdenados;

  } catch (error) {
    console.error("Error en el proceso de búsqueda:", error.message);
    throw error;
  }
}

module.exports = { buscarYRankearCandidatos };