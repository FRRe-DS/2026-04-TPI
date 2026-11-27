const { crearClienteHttp } = require("../comun/clienteHttp");

class ClienteM3M4 {
  constructor(urlM3Personalizada = null, urlM4Personalizada = null, opciones = {}) {
    this.m3Url = urlM3Personalizada || process.env.M3_URL || "http://localhost:3003";
    this.m4Url = urlM4Personalizada || process.env.M4_URL || "http://localhost:3004";
    const timeoutMs = opciones.timeoutMs ?? 3000;
    const reintentos = opciones.reintentos ?? 0;

    this.clienteM3 = crearClienteHttp({
      baseUrl: this.m3Url,
      timeoutMs,
      reintentos,
      fetchImpl: opciones.fetchImpl,
      logger: opciones.logger,
    });
    this.clienteM4 = crearClienteHttp({
      baseUrl: this.m4Url,
      timeoutMs,
      reintentos,
      fetchImpl: opciones.fetchImpl,
      logger: opciones.logger,
    });
  }

  async consultarM4(datosViaje) {
    try {
      return await this.clienteM4.post("/buscar", datosViaje);
    } catch (error) {
      throw new Error("Servicio M4 no disponible", { cause: error });
    }
  }

  async consultarM3(conductoresIds) {
    try {
      return await this.clienteM3.post("/conductores", { ids: conductoresIds });
    } catch (error) {
      throw new Error("Servicio M3 no disponible", { cause: error });
    }
  }
}

module.exports = ClienteM3M4;
