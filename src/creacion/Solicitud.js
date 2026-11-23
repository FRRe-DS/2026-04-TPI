const { randomUUID } = require("crypto");
const Coordenada = require("./Cordenada");

class SolicitudDespacho {
    constructor({
        solicitudId, clienteId, origen, destino, tipoVehiculo,
        tipoActivacion = "Inmediata", reservaId = null,
        estado = "pendiente", conductorAsignadoId = null,
        creadaEn = new Date(), ofertaEnviadaEn = null
    }) {
        if (!solicitudId) throw new Error("La solicitud debe tener un identificador");
        if (clienteId === undefined || clienteId === null || String(clienteId).trim() === "") {
            throw new Error("La solicitud debe tener un cliente");
        }
        if (!(origen instanceof Coordenada)) throw new Error("El origen debe ser una Coordenada");
        if (!(destino instanceof Coordenada)) throw new Error("El destino debe ser una Coordenada");
        if (!["AUTO", "MOTO"].includes(tipoVehiculo)) {
            throw new Error('El tipo de vehículo debe ser "AUTO" o "MOTO"');
        }
        this.solicitudId = solicitudId;
        this.clienteId = String(clienteId);
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
            clienteId: String(clienteId),
            origen, destino, tipoVehiculo,
            tipoActivacion: "Inmediata",
            reservaId: null,
            estado: "pendiente",
            conductorAsignadoId: null,
            creadaEn: new Date(),
            ofertaEnviadaEn: null
        });
    }

    toJSON() {
        return {
            solicitudId: this.solicitudId,
            clienteId: this.clienteId,
            origen: { lat: this.origen.lat, lng: this.origen.lng },
            destino: { lat: this.destino.lat, lng: this.destino.lng },
            tipoVehiculo: this.tipoVehiculo,
            tipoActivacion: this.tipoActivacion,
            reservaId: this.reservaId,
            estado: this.estado,
            conductorAsignadoId: this.conductorAsignadoId,
            creadaEn: this.creadaEn instanceof Date ? this.creadaEn.toISOString() : this.creadaEn,
            ofertaEnviadaEn: this.ofertaEnviadaEn ? new Date(this.ofertaEnviadaEn).toISOString() : null
        };
    }
}
module.exports = SolicitudDespacho;
