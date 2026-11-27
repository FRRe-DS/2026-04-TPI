// tests/soporte/mocksExternos.js
const http = require("node:http");

function crearMocksExternos() {
  const servidores = [];

  // M2: Verificación de cliente (ACTIVO / BLOQUEADO / 404)
  const m2 = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("/bloqueado")) {
      res.writeHead(200);
      res.end(JSON.stringify({ estado: "BLOQUEADO" }));
    } else if (req.url.includes("/no-encontrado")) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Cliente no encontrado" }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ estado: "ACTIVO" }));
    }
  });

  // M3: Ofertas y conductor
  const m3 = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url.includes("/offers")) {
      res.writeHead(201);
      res.end(JSON.stringify({ success: true, offerId: "mock-offer-id" }));
    } else if (req.url.includes("/dispatch-info")) {
      res.writeHead(200);
      res.end(JSON.stringify({ vehiculoId: "veh-123", tipoVehiculo: "AUTO" }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ ofertas: [], conductorId: "cond-1", vehiculoId: "veh-123", tipoVehiculo: "AUTO" }));
    }
  });

  // M4: Estimación, búsqueda, reserva (200/409), liberar
  const m4 = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url.includes("/reserva")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (body.includes("conflicto-conductor")) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "Conductor ya reservado" }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ reservado: true }));
        }
      });
    } else if (req.method === "POST" && req.url.includes("/liberar")) {
      res.writeHead(200);
      res.end(JSON.stringify({ liberado: true }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ distanciaMetros: 1500, duracionSegundos: 300 }));
    }
  });

  // M6: Viajes / Conductor asignado
  const m6 = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") {
      res.writeHead(201);
      res.end(JSON.stringify({ id: "trip-mock-uuid-999" }));
    } else {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "OK" }));
    }
  });

  // M7: Tarifas
  const m7 = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ monto: 1250.0, moneda: "ARS" }));
  });

  // M9: Emulador de reservas
  const m9 = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ reserva_id: "res-m9-001", estado: "ACTIVADA" }));
  });

  // M8: Emulador de eventos asíncronos
  const m8 = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(201);
    res.end(JSON.stringify({ recibido: true }));
  });

  return new Promise((resolve) => {
    let iniciados = 0;
    const servidoresMap = {};
    const serversList = [
      { name: "m2", srv: m2 },
      { name: "m3", srv: m3 },
      { name: "m4", srv: m4 },
      { name: "m6", srv: m6 },
      { name: "m7", srv: m7 },
      { name: "m9", srv: m9 },
      { name: "m8", srv: m8 },
    ];

    serversList.forEach((item) => {
      item.srv.listen(0, "127.0.0.1", () => {
        const port = item.srv.address().port;
        servidoresMap[item.name] = `http://127.0.0.1:${port}`;
        servidores.push(item.srv);
        iniciados++;
        if (iniciados === serversList.length) {
          resolve({
            urls: servidoresMap,
            cerrar: () => Promise.all(servidores.map((s) => new Promise((r) => s.close(r)))),
          });
        }
      });
    });
  });
}

module.exports = { crearMocksExternos };
