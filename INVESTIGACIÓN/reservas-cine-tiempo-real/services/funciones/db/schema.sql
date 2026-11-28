-- Servicio de Funciones: esquema. Base propia, separada de la de Asientos.
CREATE DATABASE IF NOT EXISTS funciones_db;
USE funciones_db;

DROP TABLE IF EXISTS funciones;

CREATE TABLE funciones (
  id INT PRIMARY KEY,
  pelicula VARCHAR(100) NOT NULL,
  sala VARCHAR(30) NOT NULL,
  horario DATETIME NOT NULL,
  filas INT NOT NULL,
  asientos_por_fila INT NOT NULL
);
