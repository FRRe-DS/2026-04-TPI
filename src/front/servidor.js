// Servidor nativo de Node.js para la página y el alta de solicitudes M5.
const http = require("http");
const fs = require("fs");
const path = require("path");
const Coordenada = require("../creacion/Cordenada");
const SolicitudDespacho = require("../creacion/Solicitud");
const listaPendientes = require("../creacion/ListaPendientes");

const PORT = Number(process.env.PORT) || 3005;
const FRONT_DIR = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("El cuerpo de la solicitud es demasiado grande"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("El cuerpo no contiene JSON válido")); }
    });
    req.on("error", reject);
  });
}

function staticFile(res, pathname) {
  const route = pathname === "/" ? "/ventana-de-solicitud.html" : pathname;
  const file = path.resolve(FRONT_DIR, "." + route);
  if (file !== FRONT_DIR && !file.startsWith(FRONT_DIR + path.sep)) {
    res.writeHead(403); return res.end("Acceso denegado");
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(err.code === "ENOENT" ? "Archivo no encontrado" : "Error al leer archivo");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(content);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "POST" && url.pathname === "/api/solicitudes/inmediata") {
    try {
      const { origen, destino, tipoVehiculo } = await readBody(req);
      if (!origen || !destino ||
          typeof origen.lat !== "number" || typeof origen.lng !== "number" ||
          typeof destino.lat !== "number" || typeof destino.lng !== "number") {
        return json(res, 400, { error: "Seleccioná un origen y un destino válidos en el mapa." });
      }
      const solicitud = SolicitudDespacho.crearInmediato(
        "001",
        new Coordenada(origen.lat, origen.lng),
        new Coordenada(destino.lat, destino.lng),
        tipoVehiculo
      );
      listaPendientes.agregar(solicitud);
      return json(res, 201, {
        solicitud: solicitud.toJSON(),
        pendientes: listaPendientes.cantidad()
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/solicitudes/pendientes") {
    return json(res, 200, {
      cantidad: listaPendientes.cantidad(),
      solicitudes: listaPendientes.obtenerTodas().map(s => s.toJSON())
    });
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { estado: "ok", modulo: "M5" });
  }

  if (req.method === "GET" || req.method === "HEAD") return staticFile(res, decodeURIComponent(url.pathname));
  return json(res, 404, { error: "Ruta no encontrada" });
}).listen(PORT, () => console.log(`Ventana de solicitud: http://localhost:${PORT}`));
