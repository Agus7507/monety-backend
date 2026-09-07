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
         SET portal_password_hash = $1, portal_activo = 1, updated_at = SYSDATETIMEOFFSET()
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
         ISNULL(e.nombre, 'Sin empresa') AS empresa,
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
           ISNULL(e.nombre, 'Sin empresa') AS empresa,
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
      await db('UPDATE solicitantes SET portal_password_hash=$1, updated_at=SYSDATETIMEOFFSET() WHERE id=$2',
        [newHash, req.solicitante.id]);

      res.json({ ok: true, mensaje: 'Contraseña actualizada exitosamente' });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// POST /api/v1/portal/recuperar-password
// Cambia la contraseña usando email + folio como verificación
// (sin necesidad de estar autenticado)
// ════════════════════════════════════════════════════════════════
router.post('/recuperar-password',
  body('email').isEmail().normalizeEmail(),
  body('folio').matches(/^MNT-\d{6}$/).withMessage('Folio inválido'),
  body('passwordNuevo').isLength({ min: 8 }),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { email, folio, passwordNuevo } = req.body;

      // Verificar que existe la combinación email + folio
      const { rows } = await db(
        `SELECT p.id, p.portal_activo
         FROM solicitantes p
         JOIN solicitudes s ON s.solicitante_id = p.id
         WHERE p.email = $1 AND s.folio = $2`,
        [email, folio.toUpperCase()]
      );

      if (!rows.length) {
        return res.status(404).json({
          ok:      false,
          message: 'No se encontró una cuenta con ese email y folio. Verifica tus datos.',
        });
      }

      const hash = await bcrypt.hash(passwordNuevo, 12);
      await db(
        `UPDATE solicitantes
         SET portal_password_hash = $1,
             portal_activo        = TRUE,
             updated_at           = NOW()
         WHERE id = $2`,
        [hash, rows[0].id]
      );

      logger.info('Contraseña recuperada', { solicitanteId: rows[0].id });
      res.json({ ok: true, mensaje: 'Contraseña actualizada exitosamente. Ya puedes iniciar sesión.' });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /api/v1/portal/documentos/:solicitudId
// Documentos del expediente del solicitante autenticado
// ════════════════════════════════════════════════════════════════
router.get('/documentos/:solicitudId', portalAuth,
  param('solicitudId').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { solicitudId } = req.params;

      // Verificar que la solicitud pertenece al solicitante autenticado
      const { rows: check } = await db(
        `SELECT id FROM solicitudes
         WHERE id = $1 AND solicitante_id = $2`,
        [solicitudId, req.solicitante.id]
      );
      if (!check.length) {
        return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
      }

      const { rows } = await db(
        `SELECT
           d.id, d.tipo, d.nombre_archivo,
           d.tamanio_bytes, d.mime_type,
           d.verificado, d.created_at
         FROM documentos d
         WHERE d.solicitud_id = $1
         ORDER BY d.created_at DESC`,
        [solicitudId]
      );

      res.json({ ok: true, documentos: rows });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /api/v1/portal/carta-termino/:solicitudId
// Carta de Término — solo disponible cuando el crédito está PAGADO
// ════════════════════════════════════════════════════════════════
router.get('/carta-termino/:solicitudId', portalAuth,
  param('solicitudId').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { solicitudId } = req.params;

      // Verificar que pertenece al solicitante
      const { rows } = await db(
        `SELECT s.folio, s.id,
                TRIM(p.nombres || ' ' || p.apellido_pat || ' ' || COALESCE(p.apellido_mat,'')) AS nombre_completo,
                c.id AS credito_id, c.estado AS estado_credito,
                c.monto_aprobado, c.plazo_meses, c.fecha_vencimiento
         FROM solicitudes s
         JOIN solicitantes p  ON p.id = s.solicitante_id
         LEFT JOIN creditos c ON c.solicitud_id = s.id
         WHERE s.id = $1 AND s.solicitante_id = $2`,
        [solicitudId, req.solicitante.id]
      );

      if (!rows.length) {
        return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
      }

      const sol = rows[0];

      if (sol.estado_credito !== 'PAGADO') {
        return res.status(403).json({
          ok:      false,
          message: 'La carta de término solo está disponible cuando el crédito ha sido liquidado en su totalidad.',
          estado:  sol.estado_credito,
        });
      }

      // Obtener fecha del último pago
      const { rows: pagos } = await db(
        `SELECT fecha_pago_real FROM amortizacion
         WHERE credito_id = $1 AND pagado = TRUE
         ORDER BY periodo DESC LIMIT 1`,
        [sol.credito_id]
      );
      const fechaLiq = pagos.length && pagos[0].fecha_pago_real
        ? new Date(pagos[0].fecha_pago_real)
        : new Date(sol.fecha_vencimiento || Date.now());

      const MESES_UP = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO',
                        'JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
      const MESES_LO = ['enero','febrero','marzo','abril','mayo','junio',
                        'julio','agosto','septiembre','octubre','noviembre','diciembre'];

      const fechaCiudad = `CIUDAD DE MÉXICO ${fechaLiq.getDate()} DE ${MESES_UP[fechaLiq.getMonth()]} DEL ${fechaLiq.getFullYear()}.`;
      const fechaTexto  = `${fechaLiq.getDate()} del mes de ${MESES_LO[fechaLiq.getMonth()]} del año ${fechaLiq.getFullYear()}`;
      const rep         = process.env.MUTUANTE_REP || 'MARCOS IVÁN DÍAZ BECERRA';
      const nombre      = (sol.nombre_completo || '').toUpperCase();

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Carta de Término de Préstamo — ${sol.folio}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap');
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Montserrat',Arial,sans-serif;font-size:13pt;color:#222;background:white}
    .page{width:216mm;min-height:279mm;margin:0 auto;padding:18mm 20mm 24mm 20mm;display:flex;flex-direction:column}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10mm}
    .logo-m{font-size:32pt;font-weight:900;color:#1BA896;line-height:1;letter-spacing:-1px}
    .logo-m span{color:#222}
    .logo-sub{font-size:7.5pt;color:#888;margin-top:2px}
    .deco{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
    .titulo{text-align:center;color:#1BA896;font-size:14pt;font-weight:700;
            letter-spacing:1px;margin-bottom:10mm;text-decoration:underline;text-underline-offset:4px}
    .fecha{text-align:right;font-size:11pt;margin-bottom:14mm}
    .cuerpo{flex:1;font-size:12pt;line-height:2.2;text-align:justify;margin-bottom:14mm}
    .nombre{font-weight:700}
    .firma{margin-top:10mm;text-align:center}
    .firma-linea{width:220px;border-top:1.5px solid #222;margin:8mm auto 4mm}
    .firma-nombre{font-size:11pt;font-weight:700}
    .footer{margin-top:auto;padding-top:6mm;border-top:2px solid #1BA896;
            display:flex;justify-content:center;align-items:center;gap:28px}
    .footer-item{display:flex;align-items:center;gap:5px;font-size:8pt;color:#888;font-weight:600}
    .fi{width:18px;height:18px;border-radius:50%;background:#1BA896;
        display:flex;align-items:center;justify-content:center;color:white;font-size:8pt}
    .print-btn{position:fixed;bottom:24px;right:24px;background:#1BA896;color:white;
               border:none;border-radius:50px;padding:14px 28px;font-size:14px;
               font-weight:700;cursor:pointer;font-family:inherit;
               box-shadow:0 4px 16px rgba(27,168,150,.4);z-index:999}
    @media print{.print-btn{display:none}}
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">⬇ Imprimir / Guardar PDF</button>
  <div class="page">
    <div class="header">
      <div>
        <div class="logo-m"><span>M</span>onety</div>
        <div class="logo-sub">Soluciones financieras que te respaldan</div>
      </div>
      <div class="deco">
        <div style="display:flex;gap:6px;">
          <div style="width:55px;height:16px;background:#888;border-radius:20px;transform:rotate(-35deg)"></div>
          <div style="width:20px;height:20px;background:#b0b0b0;border-radius:50%"></div>
        </div>
        <div style="display:flex;gap:6px;margin-top:4px;">
          <div style="width:42px;height:13px;background:#1BA896;border-radius:20px;transform:rotate(-35deg)"></div>
          <div style="width:16px;height:16px;background:#1BA896;border-radius:50%"></div>
        </div>
      </div>
    </div>

    <div class="titulo">CARTA DE TERMINO DE PRESTAMO</div>
    <div class="fecha">${fechaCiudad}</div>

    <div class="cuerpo">
      Por medio de la presente se hace constar que el préstamo solicitado a nombre del C.

      <span class="nombre">${nombre}</span> fue concluido el día ${fechaTexto}.

      Asimismo, en su calidad de titular de este, se informa que dicho préstamo se

      encuentra totalmente liquidado conforme a los pagos acordados.
    </div>

    <div class="firma">
      <div style="font-size:11pt">En señal de conformidad se firma el documento.</div>
      <div class="firma-linea"></div>
      <div class="firma-nombre">${rep}</div>
    </div>

    <div class="footer">
      <div class="footer-item"><div class="fi">📸</div><span>@monety.finanzas</span></div>
      <div class="footer-item"><div class="fi">🌐</div><span>www.monety.mx</span></div>
      <div class="footer-item"><div class="fi">in</div><span>Monety</span></div>
    </div>
  </div>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) { next(err); }
  }
);

module.exports = { router, portalAuth };
