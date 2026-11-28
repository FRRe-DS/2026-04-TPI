const { createServer } = require('node:http');
const express = require('express');
const adaptadorAsientos = require('./adaptador-asientos');
const { iniciarTiempoReal } = require('./index');
const { crearMetricas } = require('./metricas');

function crearServidor({ adaptador = adaptadorAsientos, log = console.log } = {}) {
  const app = express();
  const servidor = createServer(app);
  const metricas = crearMetricas();
  const tiempoReal = iniciarTiempoReal({
    servidor, proveedorGrilla: adaptador, metricas, log,
    suscribirCambios: adaptador.suscribirCambios,
    validarToken: adaptador.validarToken,
    verificarCambio: adaptador.verificarCambio,
  });

  app.get('/api/metricas/conexiones', adaptador.autenticarHttp, (req, res) => {
    res.json(metricas.conexiones(tiempoReal.conexionesPorFuncion()));
  });
  app.get('/api/metricas/solicitudes', adaptador.autenticarHttp, metricas.solicitudes);
  adaptador.montarRest(app, metricas.registrarPolling);

  let barrido;
  const { intervaloVencimientoMs } = adaptador.configuracion();
  const temporizador = setInterval(() => {
    if (barrido) return;
    barrido = adaptador.liberarVencidos(tiempoReal.difundir).catch((error) => {
      log(JSON.stringify({ evento: 'error_barrido_vencimientos', codigo: error.code || error.name }));
    }).finally(() => { barrido = null; });
  }, intervaloVencimientoMs);
  temporizador.unref();

  let cierre;
  function cerrar() {
    if (cierre) return cierre;
    clearInterval(temporizador);
    const cierreHttp = new Promise((resolver, rechazar) => {
      servidor.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') rechazar(error);
        else resolver();
      });
    });
    cierre = Promise.all([cierreHttp, tiempoReal.cerrar(), barrido]).then(() => adaptador.cerrarBase());
    return cierre;
  }
  return { servidor, cerrar };
}

if (require.main === module) {
  const { puerto, errorInicio } = adaptadorAsientos.configuracion();
  if (errorInicio) {
    console.error(errorInicio);
    process.exit(1);
  }
  const { servidor, cerrar } = crearServidor();
  servidor.listen(puerto, () => console.log(`Servicio de Asientos con tiempo real escuchando en el puerto ${puerto}`));

  const apagar = () => cerrar().catch((error) => {
    console.error('Error al cerrar el servicio:', error.code || error.name);
    process.exitCode = 1;
  });
  process.once('SIGTERM', apagar);
  process.once('SIGINT', apagar);
}

module.exports = { crearServidor };
