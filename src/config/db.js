const { Pool } = require('pg');
const logger   = require('./logger');

// Railway provee DATABASE_URL automáticamente.
// En desarrollo usamos las variables individuales del .env.
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },  // requerido por Railway/Render
      max: parseInt(process.env.DB_POOL_MAX || '10'),
      idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE || '30000'),
      connectionTimeoutMillis: parseInt(process.env.DB_POOL_ACQUIRE || '60000'),
    }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT  || '5432'),
      database: process.env.DB_NAME     || 'monety_db',
      user:     process.env.DB_USER     || 'monety_user',
      password: process.env.DB_PASSWORD,
      max:      parseInt(process.env.DB_POOL_MAX     || '10'),
      idleTimeoutMillis:       parseInt(process.env.DB_POOL_IDLE    || '30000'),
      connectionTimeoutMillis: parseInt(process.env.DB_POOL_ACQUIRE || '60000'),
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('Nueva conexión al pool de PostgreSQL');
});

/**
 * Ejecuta una query y devuelve las filas.
 * @param {string} text   SQL con placeholders $1, $2 …
 * @param {any[]}  params Valores para los placeholders
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    logger.debug('Query ejecutada', {
      sql:      text.replace(/\s+/g, ' ').substring(0, 80),
      rows:     res.rowCount,
      duration: Date.now() - start + 'ms',
    });
    return res;
  } catch (err) {
    logger.error('Error en query', { sql: text, error: err.message });
    throw err;
  }
}

/** Verifica la conexión con la BD al arrancar. */
async function testConnection() {
  const client = await pool.connect();
  const { rows } = await client.query('SELECT NOW() AS now, current_database() AS db');
  client.release();
  logger.info(`PostgreSQL conectado — BD: ${rows[0].db} — ${rows[0].now}`);
}

module.exports = { query, pool, testConnection };
