-- Los ids 41, 42 y 43 coinciden con las funciones que tienen asientos en asientos_db.
USE funciones_db;

DELETE FROM funciones;

INSERT INTO funciones (id, pelicula, sala, horario, filas, asientos_por_fila) VALUES
  (41, 'Dune',         'Sala 1', DATE_ADD(NOW(), INTERVAL 1 DAY), 8, 12),
  (42, 'Matrix',       'Sala 3', DATE_ADD(NOW(), INTERVAL 2 DAY), 8, 12),
  (43, 'Interestelar', 'Sala 2', DATE_ADD(NOW(), INTERVAL 3 DAY), 8, 12);
