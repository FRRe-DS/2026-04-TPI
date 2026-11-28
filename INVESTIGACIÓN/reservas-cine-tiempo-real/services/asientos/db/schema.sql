-- Servicio de Asientos: esquema. Se puede ejecutar las veces que haga falta (recrea la tabla).
CREATE DATABASE IF NOT EXISTS asientos_db;
USE asientos_db;

DROP TABLE IF EXISTS asientos;

CREATE TABLE asientos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  funcion_id INT NOT NULL,
  fila CHAR(1) NOT NULL,
  numero INT NOT NULL,
  estado ENUM('libre','bloqueado','vendido') NOT NULL DEFAULT 'libre',
  bloqueado_por VARCHAR(50) NULL,
  bloqueado_hasta DATETIME NULL,
  version INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_asiento (funcion_id, fila, numero),
  INDEX idx_funcion (funcion_id)
);
