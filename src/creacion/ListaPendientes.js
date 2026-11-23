/*
 * Instancia única compartida por los módulos que importen este archivo
 * dentro del mismo proceso de Node.js. Actualmente se guarda en memoria.
 */
class ListaPendientes {
    constructor() {
        this.solicitudes = [];
    }

    agregar(solicitud) {
        if (!solicitud || solicitud.estado !== "pendiente") {
            throw new Error('Solo se pueden agregar solicitudes en estado "pendiente"');
        }
        if (this.solicitudes.some(item => item.solicitudId === solicitud.solicitudId)) {
            throw new Error("La solicitud ya existe en la Lista de pendientes");
        }
        this.solicitudes.push(solicitud);
        return solicitud;
    }

    obtenerTodas() {
        return [...this.solicitudes];
    }

    buscarPorId(solicitudId) {
        return this.solicitudes.find(item => item.solicitudId === solicitudId) || null;
    }

    quitarPorId(solicitudId) {
        const index = this.solicitudes.findIndex(item => item.solicitudId === solicitudId);
        if (index < 0) return false;
        this.solicitudes.splice(index, 1);
        return true;
    }

    cantidad() {
        return this.solicitudes.length;
    }
}

module.exports = new ListaPendientes();
