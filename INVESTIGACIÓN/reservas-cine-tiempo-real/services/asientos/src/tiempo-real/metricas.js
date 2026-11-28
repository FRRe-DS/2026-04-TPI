const { performance } = require('node:perf_hooks');

const VENTANA_MAXIMA = 3600;
const VENTANA_PREDETERMINADA = 60;

function primerIndiceDesde(marcas, inicio, desde) {
  let fin = marcas.length;
  while (inicio < fin) {
    const medio = Math.floor((inicio + fin) / 2);
    if (marcas[medio] < desde) inicio = medio + 1;
    else fin = medio;
  }
  return inicio;
}

function crearContadorPolling(ahora = () => performance.now()) {
  let marcas = [];
  let inicio = 0;

  function descartar(instantaneo) {
    inicio = primerIndiceDesde(marcas, inicio, instantaneo - VENTANA_MAXIMA * 1000);
    if (inicio > 0 && inicio * 2 >= marcas.length) {
      marcas = marcas.slice(inicio);
      inicio = 0;
    }
  }

  return {
    registrar() {
      const instantaneo = ahora();
      descartar(instantaneo);
      marcas.push(instantaneo);
    },
    contar(ventanaSegundos) {
      const instantaneo = ahora();
      descartar(instantaneo);
      return marcas.length - primerIndiceDesde(marcas, inicio, instantaneo - ventanaSegundos * 1000);
    },
    purgar: () => descartar(ahora()),
  };
}

function crearMetricas() {
  const polling = crearContadorPolling();
  let mensajesEmitidos = 0;

  return {
    registrarPolling: polling.registrar,
    purgarPolling: polling.purgar,
    registrarMensaje() {
      mensajesEmitidos += 1;
    },
    conexiones(conexionesPorFuncion) {
      const conexionesActivas = Object.values(conexionesPorFuncion).reduce((total, cantidad) => total + cantidad, 0);
      return { conexionesActivas, conexionesPorFuncion, mensajesEmitidos };
    },
    solicitudes(req, res) {
      const parametro = req.query.ventanaSegundos ?? String(VENTANA_PREDETERMINADA);
      const ventanaSegundos = Number(parametro);
      if (typeof parametro !== 'string' || !/^\d+$/.test(parametro) ||
          ventanaSegundos < 1 || ventanaSegundos > VENTANA_MAXIMA) {
        return res.status(400).json({
          codigo: 'SOLICITUD_INVALIDA',
          mensaje: 'ventanaSegundos debe ser un entero entre 1 y 3600.',
        });
      }
      res.json({ ventanaSegundos, solicitudesPolling: polling.contar(ventanaSegundos) });
    },
  };
}

module.exports = { crearMetricas, crearContadorPolling };
