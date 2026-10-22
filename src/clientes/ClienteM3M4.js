const axios = require('axios');

class ClienteM3M4 {
  constructor(urlM3Personalizada = null, urlM4Personalizada = null) {
    this.m3Url = urlM3Personalizada || process.env.M3_URL || 'http://localhost:3003';
    this.m4Url = urlM4Personalizada || process.env.M4_URL || 'http://localhost:3004';
  }

  async consultarM4(datosViaje) {
    try {
      const respuesta = await axios.post(`${this.m4Url}/buscar`, datosViaje, { timeout: 3000 });
      return respuesta.data;
    } catch (error) {
      throw new Error("Servicio M4 no disponible");
    }
  }

  async consultarM3(conductoresIds) {
    try {
      const respuesta = await axios.post(`${this.m3Url}/conductores`, { ids: conductoresIds }, { timeout: 3000 });
      return respuesta.data;
    } catch (error) {
      throw new Error("Servicio M3 no disponible");
    }
  }
}

module.exports = ClienteM3M4;