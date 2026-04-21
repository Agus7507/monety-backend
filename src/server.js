require('dotenv').config();
const app    = require('./app');
const { testConnection } = require('./config/db');
const logger = require('./config/logger');

const PORT = parseInt(process.env.PORT || '4000');

async function start() {
  // Arrancar el servidor PRIMERO para que Railway pase el healthcheck
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 Monety API corriendo en http://0.0.0.0:${PORT}`);
    logger.info(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`   Prefijo: ${process.env.API_PREFIX || '/api/v1'}`);
  });

  // Intentar conectar a BD con reintentos (Railway puede tardar unos segundos)
  let intentos = 0;
  const maxIntentos = 10;

  const conectarBD = async () => {
    try {
      await testConnection();
    } catch (err) {
      intentos++;
      if (intentos < maxIntentos) {
        logger.warn(`BD no disponible aún, reintentando en 3s (${intentos}/${maxIntentos})...`);
        setTimeout(conectarBD, 3000);
      } else {
        logger.error('No se pudo conectar a PostgreSQL después de varios intentos', { error: err.message });
        // No hacer process.exit — el servidor sigue respondiendo /health
      }
    }
  };

  conectarBD();

  // Apagado elegante
  const shutdown = (signal) => {
    logger.info(`${signal} recibido — cerrando servidor...`);
    server.close(() => {
      logger.info('Servidor cerrado.');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start();
