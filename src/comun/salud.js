// /health (vivo) y /health/ready (listo, con chequeos opcionales de MySQL/Redis).
const express = require("express");

const TIMEOUT_CHEQUEO_MS = 2000;

function conTimeout(promesa, ms) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new Error("timeout")), ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

// chequeos: { mysql: async () => {...}, redis: async () => {...} }  (lanzar si falla)
function crearRouterSalud({ chequeos = {} } = {}) {
  const router = express.Router();

  router.get("/health", (req, res) => {
    res.status(200).json({ estado: "ok" });
  });

  router.get("/health/ready", async (req, res) => {
    const nombres = Object.keys(chequeos);
    const resultados = await Promise.allSettled(
      nombres.map((n) => conTimeout(Promise.resolve().then(chequeos[n]), TIMEOUT_CHEQUEO_MS))
    );
    const componentes = {};
    nombres.forEach((n, i) => {
      componentes[n] = resultados[i].status === "fulfilled" ? "ok" : "falla";
    });
    const listo = Object.values(componentes).every((v) => v === "ok");
    res.status(listo ? 200 : 503).json({ estado: listo ? "ok" : "degradado", componentes });
  });

  return router;
}

module.exports = { crearRouterSalud };
