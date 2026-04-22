require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const logger     = require('./config/logger');
const { globalErrorHandler } = require('./middleware/errorHandler');

const app    = express();
const PREFIX = process.env.API_PREFIX || '/api/v1';

/* ── Seguridad ────────────────────────────────────────────── Se pone en lo que se corren las pruebas*/
app.use(helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ['self'],
      scriptSrc: ['self', 'unsafe-inline'], // ⚠️
      scriptSrcAttr: ['unsafe-inline'],       // ⚠️
    },
  })
);

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
  .split(',').map(o => o.trim());

const isDev = (process.env.NODE_ENV || 'development') === 'development';

app.use(cors({
  origin: (origin, cb) => {
    // En desarrollo: permite archivos locales (origin=undefined/null) y orígenes configurados
    if (!origin && isDev) return cb(null, true);          // archivo file:///
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origen ${origin} no permitido`));
  },
  methods:     ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

/* ── Rate limiting ────────────────────────────────────────── */
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MIN || '15') * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX || '100'),
  message:  { ok: false, message: 'Demasiadas solicitudes, intenta más tarde' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Rate limit más estricto solo para el envío de solicitudes (evita spam)
// En desarrollo se sube el límite para facilitar pruebas
const limiterSolicitud = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 1000,
  message: { ok: false, message: 'Límite de solicitudes alcanzado por hora' },
});

app.use(limiter);

/* ── Parsers y logging ────────────────────────────────────── */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
  stream: { write: msg => logger.http(msg.trim()) },
}));

/* ── Health check ─────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ── Rutas ────────────────────────────────────────────────── */
app.use(`${PREFIX}/auth`,        require('./routes/auth'));
app.use(`${PREFIX}/simulador`,   require('./routes/simulador'));
app.use(`${PREFIX}/empresas`,    require('./routes/empresas'));
app.use(`${PREFIX}/solicitudes`, limiterSolicitud, require('./routes/solicitudes'));
app.use(`${PREFIX}/creditos`,    require('./routes/creditos'));
app.use(`${PREFIX}/dashboard`,   require('./routes/dashboard'));

/* ── 404 ──────────────────────────────────────────────────── */
app.use((_req, res) => {
  res.status(404).json({ ok: false, message: 'Ruta no encontrada' });
});

/* ── Error global ─────────────────────────────────────────── */
app.use(globalErrorHandler);

module.exports = app;
