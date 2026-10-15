
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
        estado = "CREADA",
        conductorAsignadoId = null,
        version = 1,
        claveIdempotencia,
        creadaEn = new Date(),
        ofertaEnviadaEn = null
    }) {
        if (!solicitudId) {
            throw new Error("La solicitud debe tener un ID");
        }

        if (!clienteId) {
            throw new Error("La solicitud debe tener un cliente");
        }

        if (!(origen instanceof Coordenada)) {
            throw new Error("El origen debe ser una Coordenada");
        }

        if (!(destino instanceof Coordenada)) {
            throw new Error("El destino debe ser una Coordenada");
        }

        const tiposVehiculo = ["AUTO", "MOTO"];

        if (!tiposVehiculo.includes(tipoVehiculo)) {
            throw new Error("Tipo de vehículo inválido");
        }

        this.solicitudId = solicitudId;
        this.clienteId = clienteId;
        this.origen = origen;
        this.destino = destino;
        this.tipoVehiculo = tipoVehiculo;
        this.tipoActivacion = tipoActivacion;
        this.reservaId = reservaId;
        this.estado = estado;
        this.conductorAsignadoId = conductorAsignadoId;
        this.version = version;
        this.claveIdempotencia = claveIdempotencia;
        this.creadaEn = creadaEn;
        this.ofertaEnviadaEn = ofertaEnviadaEn;
    }

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
        this.version++;
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
