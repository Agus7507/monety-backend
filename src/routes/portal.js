/**
 * portal.js
 * API para el Portal del Solicitante.
 * Los solicitantes se registran y acceden con email + contraseña.
 * Solo ven sus propias solicitudes, créditos y documentos.
 *
 * Rutas:
 *   POST /api/v1/portal/registro      → crear cuenta (email + password)
 *   POST /api/v1/portal/login         → iniciar sesión → JWT
 *   GET  /api/v1/portal/perfil        → datos del solicitante
 *   GET  /api/v1/portal/solicitudes   → mis solicitudes
 *   GET  /api/v1/portal/solicitudes/:folio → detalle de una solicitud
 *   GET  /api/v1/portal/creditos      → mis créditos activos
 *   GET  /api/v1/portal/creditos/:id/amortizacion → mi tabla de pagos
 *   GET  /api/v1/portal/documentos/:solicitudId   → mis documentos
 *   POST /api/v1/portal/cambiar-password          → cambiar contraseña
 */

const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { body, param } = require('express-validator');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { query: db, pool } = require('../config/db');
const logger   = require('../config/logger');

// ── Middleware: verificar JWT del portal (solicitante) ────────
async function portalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, message: 'Sesión requerida' });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (payload.tipo !== 'solicitante') {
      return res.status(403).json({ ok: false, message: 'Token inválido para el portal' });
    }
    // Verificar que el solicitante existe y tiene cuenta activa
    const { rows } = await db(
      'SELECT id, nombres, apellido_pat, email, portal_activo FROM solicitantes WHERE id=$1',
      [payload.sub]
    );
    if (!rows.length || !rows[0].portal_activo) {
      return res.status(401).json({ ok: false, message: 'Cuenta inactiva o no encontrada' });
    }
    req.solicitante = rows[0];
    next();
  } catch {
    return res.status(401).json({ ok: false, message: 'Sesión expirada. Vuelve a iniciar sesión.' });
  }
}

// ── Helpers ───────────────────────────────────────────────────
function fmtMXN(n) {
  return Number(n || 0).toLocaleString('es-MX', {
    style: 'currency', currency: 'MXN', minimumFractionDigits: 2
  });
}

// ════════════════════════════════════════════════════════════════
// POST /api/v1/portal/registro
// El solicitante crea su cuenta usando el email que registró en la solicitud.
// ════════════════════════════════════════════════════════════════
router.post('/registro',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres'),
  body('folio').matches(/^MNT-\d{6}$/).withMessage('Folio inválido (ej. MNT-000001)'),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { email, password, folio } = req.body;

      // Verificar que existe una solicitud con ese email y folio
      const { rows: check } = await db(
        `SELECT p.id, p.nombres, p.apellido_pat, p.portal_password_hash, p.portal_activo
         FROM solicitantes p
         JOIN solicitudes s ON s.solicitante_id = p.id
         WHERE p.email = $1 AND s.folio = $2`,
        [email, folio.toUpperCase()]
      );

      if (!check.length) {
        return res.status(404).json({
          ok: false,
          message: 'No se encontró una solicitud con ese email y folio. '
                 + 'Verifica los datos o completa el formulario primero.'
        });
      }

      const sol = check[0];

      if (sol.portal_activo && sol.portal_password_hash) {
        return res.status(409).json({
          ok: false,
          message: 'Ya tienes una cuenta registrada. Usa "Iniciar sesión".'
        });
      }

      // Crear cuenta
      const hash = await bcrypt.hash(password, 12);
      await db(
        `UPDATE solicitantes
         SET portal_password_hash = $1, portal_activo = TRUE, updated_at = NOW()
         WHERE id = $2`,
        [hash, sol.id]
      );

      const token = jwt.sign(
        { sub: sol.id, tipo: 'solicitante' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }  // sesión larga para el portal
      );

      logger.info('Cuenta portal creada', { solicitanteId: sol.id, email });

      res.status(201).json({
        ok: true,
        token,
        solicitante: {
          nombre: `${sol.nombres} ${sol.apellido_pat}`,
          email,
        },
        mensaje: '¡Cuenta creada exitosamente! Ya puedes ver el estado de tu solicitud.',
      });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// POST /api/v1/portal/login
// ════════════════════════════════════════════════════════════════
router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;

      const { rows } = await db(
        `SELECT id, nombres, apellido_pat, email, portal_password_hash, portal_activo
         FROM solicitantes WHERE email = $1`,
        [email]
      );

      if (!rows.length || !rows[0].portal_password_hash) {
        return res.status(401).json({
          ok: false,
          message: 'Email no registrado o cuenta no activada. Usa el botón "Crear cuenta".'
        });
      }

      const sol   = rows[0];
      const valid = await bcrypt.compare(password, sol.portal_password_hash);

      if (!valid) {
        return res.status(401).json({ ok: false, message: 'Contraseña incorrecta' });
      }

      if (!sol.portal_activo) {
        return res.status(403).json({ ok: false, message: 'Cuenta desactivada. Contacta a Monety.' });
      }

      const token = jwt.sign(
        { sub: sol.id, tipo: 'solicitante' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      logger.info('Login portal', { solicitanteId: sol.id });

      res.json({
        ok: true,
        token,
        solicitante: {
          id:     sol.id,
          nombre: `${sol.nombres} ${sol.apellido_pat}`,
          email:  sol.email,
        },
      });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /api/v1/portal/perfil
// ════════════════════════════════════════════════════════════════
router.get('/perfil', portalAuth, async (req, res, next) => {
  try {
    const { rows } = await db(
      `SELECT nombres, apellido_pat, apellido_mat, email, telefono,
              curp, rfc, calle, colonia, alcaldia_mpio, entidad, cp
       FROM solicitantes WHERE id = $1`,
      [req.solicitante.id]
    );
    res.json({ ok: true, perfil: rows[0] });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/v1/portal/solicitudes
// ════════════════════════════════════════════════════════════════
router.get('/solicitudes', portalAuth, async (req, res, next) => {
  try {
    const { rows } = await db(
      `SELECT
         s.id, s.folio, s.estado, s.fecha_solicitud,
         s.tipo_credito, s.tipo_nomina,
         s.monto_solicitado, s.plazo_meses,
         s.salario_mensual_neto,
         COALESCE(e.nombre, 'Sin empresa') AS empresa,
         ev.ranking, ev.puntaje_total, ev.resultado, ev.motivo_rechazo,
         c.monto_aprobado, c.pago_mensual_total,
         c.tasa_nominal_anual, c.cat_anual,
         c.fecha_desembolso, c.fecha_vencimiento,
         c.saldo_insoluto, c.estado AS estado_credito
       FROM solicitudes s
       LEFT JOIN empresas e      ON e.id = s.empresa_id
       LEFT JOIN evaluaciones ev ON ev.solicitud_id = s.id
       LEFT JOIN creditos c      ON c.solicitud_id = s.id
       WHERE s.solicitante_id = $1
       ORDER BY s.created_at DESC`,
      [req.solicitante.id]
    );
    res.json({ ok: true, solicitudes: rows });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════
// GET /api/v1/portal/solicitudes/:folio
// ════════════════════════════════════════════════════════════════
router.get('/solicitudes/:folio', portalAuth,
  param('folio').matches(/^MNT-\d{6}$/),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { rows } = await db(
        `SELECT
           s.id, s.folio, s.estado, s.fecha_solicitud,
           s.tipo_credito, s.tipo_nomina, s.monto_solicitado, s.plazo_meses,
           COALESCE(e.nombre,'Sin empresa') AS empresa,
           ev.ranking, ev.puntaje_total, ev.resultado, ev.motivo_rechazo,
           ev.puntos_ingreso, ev.puntos_historial, ev.puntos_antiguedad, ev.puntos_capacidad_pago,
           c.id AS credito_id, c.monto_aprobado, c.pago_mensual_total,
           c.tasa_nominal_anual, c.cat_anual,
           c.fecha_desembolso, c.fecha_inicio_descuento, c.fecha_vencimiento,
           c.saldo_insoluto, c.estado AS estado_credito
         FROM solicitudes s
         LEFT JOIN empresas e      ON e.id = s.empresa_id
         LEFT JOIN evaluaciones ev ON ev.solicitud_id = s.id
         LEFT JOIN creditos c      ON c.solicitud_id = s.id
         WHERE s.folio = $1 AND s.solicitante_id = $2`,
        [req.params.folio.toUpperCase(), req.solicitante.id]
      );

      if (!rows.length) {
        return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
      }

      // Historial de estados
      const { rows: historial } = await db(
        `SELECT estado_anterior, estado_nuevo, comentario, created_at
         FROM historial_estados WHERE solicitud_id = $1 ORDER BY created_at ASC`,
        [rows[0].id]
      );

      // Documentos subidos
      const { rows: docs } = await db(
        `SELECT tipo, nombre_archivo, verificado, created_at
         FROM documentos WHERE solicitud_id = $1`,
        [rows[0].id]
      );

      res.json({ ok: true, solicitud: rows[0], historial, documentos: docs });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /api/v1/portal/creditos/:id/amortizacion
// ════════════════════════════════════════════════════════════════
router.get('/creditos/:id/amortizacion', portalAuth,
  param('id').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      // Verificar que el crédito pertenece al solicitante
      const { rows: check } = await db(
        `SELECT c.id FROM creditos c
         JOIN solicitudes s ON s.id = c.solicitud_id
         WHERE c.id = $1 AND s.solicitante_id = $2`,
        [req.params.id, req.solicitante.id]
      );
      if (!check.length) return res.status(404).json({ ok: false, message: 'Crédito no encontrado' });

      const { rows } = await db(
        `SELECT periodo, fecha_pago, saldo_inicial, capital, interes,
                iva, pago_fijo, pago_total, saldo_insoluto, pagado, fecha_pago_real
         FROM amortizacion WHERE credito_id = $1 ORDER BY periodo`,
        [req.params.id]
      );
      res.json({ ok: true, amortizacion: rows });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// POST /api/v1/portal/cambiar-password
// ════════════════════════════════════════════════════════════════
router.post('/cambiar-password', portalAuth,
  body('passwordActual').notEmpty(),
  body('passwordNuevo').isLength({ min: 8 }),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { passwordActual, passwordNuevo } = req.body;

      const { rows } = await db(
        'SELECT portal_password_hash FROM solicitantes WHERE id=$1',
        [req.solicitante.id]
      );

      const valid = await bcrypt.compare(passwordActual, rows[0].portal_password_hash);
      if (!valid) return res.status(401).json({ ok: false, message: 'Contraseña actual incorrecta' });

      const newHash = await bcrypt.hash(passwordNuevo, 12);
      await db('UPDATE solicitantes SET portal_password_hash=$1, updated_at=NOW() WHERE id=$2',
        [newHash, req.solicitante.id]);

      res.json({ ok: true, mensaje: 'Contraseña actualizada exitosamente' });
    } catch (err) { next(err); }
  }
);

module.exports = { router, portalAuth };
