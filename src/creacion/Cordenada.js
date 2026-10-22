class Coordenada {
    constructor(lat, lng) {
        if (typeof lat !== "number" || !Number.isFinite(lat)) {
            throw new Error("La latitud debe ser un número válido");
        }
        if (typeof lng !== "number" || !Number.isFinite(lng)) {
            throw new Error("La longitud debe ser un número válido");
        }
        if (lat < -90 || lat > 90) {
            throw new Error("La latitud debe estar entre -90 y 90");
        }
        if (lng < -180 || lng > 180) {
            throw new Error("La longitud debe estar entre -180 y 180");
        }
        this.lat = lat;
        this.lng = lng;
    }
}

module.exports = Coordenada;
