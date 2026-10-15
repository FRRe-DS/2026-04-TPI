const { randomUUID } = require("crypto");
const Coordenada = require("./Coordenada");

class SolicitudDespacho {
    constructor({
        solicitudId,
        clienteId,
        origen,
        destino,
        tipoVehiculo,
        tipoActivacion,
        estado = "pendiente",
        conductorAsignadoId = null,
        creadaEn = new Date(),
        ofertaEnviadaEn = null
    }) {
        this.solicitudId = solicitudId;
        this.clienteId = clienteId;
        this.origen = origen;
        this.destino = destino;
        this.tipoVehiculo = tipoVehiculo;
        this.tipoActivacion = tipoActivacion;
        this.reservaId = reservaId;
        this.estado = estado;
        this.conductorAsignadoId = conductorAsignadoId;
        this.creadaEn = creadaEn;
        this.ofertaEnviadaEn = ofertaEnviadaEn;
    }

    static crearInmediato(clienteId, origen, destino, tipoVehiculo) {
        return new SolicitudDespacho({
            solicitudId: randomUUID(),
            clienteId: clienteId,
            origen: origen,
            destino: destino,
            tipoVehiculo: tipoVehiculo,
            tipoActivacion: "Inmediata",
            estado: "pendiente"
        });
    }
    static crearReserva(clienteId, origen, destino, tipoVehiculo) {
        return new SolicitudDespacho({
            solicitudId: randomUUID(),
            clienteId: clienteId,
            origen: origen,
            destino: destino,
            tipoVehiculo: tipoVehiculo,
            tipoActivacion: "Reserva",
            estado: "pendiente"
        });
    }
}
