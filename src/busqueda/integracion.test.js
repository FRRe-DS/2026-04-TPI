const http = require('http');
const ClienteM3M4 = require('../clientes/ClienteM3M4');

describe('Pruebas de Integración - Manejo de servicios caídos (RNF-13)', () => {
  
  test('Debería arrojar error cuando M3 responde con falla (servidor caído)', async () => {
    // Creamos un servidor web falso que responde un Error 500 al toque
    const servidorFalsoM3 = http.createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Caido' }));
    });

    // Lo ponemos a escuchar en un puerto libre, por ejemplo el 3099
    await new Promise(resolve => servidorFalsoM3.listen(3099, resolve));

    // Instanciamos nuestro cliente apuntando a ese servidor falso de prueba
    const clientePrueba = new ClienteM3M4('http://localhost:3099', 'http://localhost:3004');

    // Verificamos que al consultar, nuestro código atrapa el error y lanza la excepción esperada
    await expect(clientePrueba.consultarM3([1, 2])).rejects.toThrow("Servicio M3 no disponible");

    // Cerramos el servidor falso
    await new Promise(resolve => servidorFalsoM3.close(resolve));
  });

});