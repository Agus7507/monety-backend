require('dotenv').config();
const app    = require('./app');
const { testConnection } = require('./config/db');
const logger = require('./config/logger');

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    await testConnection();
    const server = app.listen(PORT, () => {
      logger.info(`🚀 Monety API corriendo en http://localhost:${PORT}`);
      logger.info(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`   Prefijo: ${process.env.API_PREFIX || '/api/v1'}`);
    });

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

  } catch (err) {
    logger.error('Error al iniciar el servidor', { error: err.message });
    process.exit(1);
  }
}

start();
