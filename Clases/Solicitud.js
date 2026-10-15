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
        reservaId = null,
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

    static crear(clienteId, origen, destino, tipoVehiculo) {
        return new SolicitudDespacho({
            solicitudId: randomUUID(),
            clienteId: clienteId,
            origen: origen,
            destino: destino,
            tipoVehiculo: tipoVehiculo,
            tipoActivacion: "INMEDIATA",
            estado: "pendiente"
        });
    }
}

module.exports = SolicitudDespacho;

    crear() {
        if (this.estado !== "CREADA") {
            throw new Error(
                "Solo se puede iniciar una solicitud en estado CREADA"
            );
        }

        this.estado = "BUSCANDO";
        return this;
    }

    cancelar(motivo) {
        if (!motivo || motivo.trim() === "") {
            throw new Error("Debe indicar el motivo de cancelación");
        }

        const estadosNoCancelables = [
            "COMPLETADA",
            "CANCELADA",
            "SIN_DISPONIBILIDAD"
        ];

        if (estadosNoCancelables.includes(this.estado)) {
            throw new Error(
                `No se puede cancelar una solicitud en estado ${this.estado}`
            );
        }

        this.estado = "CANCELADA";
        this.motivoCancelacion = motivo;
    }

    asignar(ofertaId, conductorId) {
        if (this.estado !== "BUSCANDO") {
            throw new Error(
                "Solo se puede asignar un conductor mientras se busca"
            );
        }

        if (!ofertaId || !conductorId) {
            throw new Error(
                "Se necesitan el ID de la oferta y el ID del conductor"
            );
        }

        if (this.conductorAsignadoId !== null) {
            throw new Error("La solicitud ya tiene un conductor asignado");
        }

        this.conductorAsignadoId = conductorId;
        this.ofertaAsignadaId = ofertaId;
        this.estado = "ASIGNADA";
        return true;
    }

    marcarSinDisponibilidad() {
        if (this.estado !== "BUSCANDO") {
            throw new Error(
                "Solo se puede marcar sin disponibilidad durante la búsqueda"
            );
        }

        this.estado = "SIN_DISPONIBILIDAD";
    }
}

module.exports = SolicitudDespacho;
