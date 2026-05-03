/**
 * layouts.js
 * API para el módulo de Layouts de Nómina.
 * Conecta el backoffice con la tabla layouts_nomina de PostgreSQL.
 */

const router = require('express').Router();
const { body, param, query: qv } = require('express-validator');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { query: db, pool } = require('../config/db');
const logger = require('../config/logger');

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/layouts
   Lista layouts filtrados por periodo, empresa, tipo y estado.
   ───────────────────────────────────────────────────────────── */
router.get('/',
  authMiddleware,
  async (req, res, next) => {
    try {
      const {
        periodo,
        empresa_id,
        tipo     = '',
        estado   = '',
        page     = '1',
        limit    = '200',
      } = req.query;

      const conditions = [];
      const params     = [];

      if (periodo) {
        params.push(periodo);
        conditions.push(`l.periodo = $${params.length}`);
      }
      if (empresa_id) {
        params.push(parseInt(empresa_id));
        conditions.push(`e.id = $${params.length}`);
      }
      if (tipo) {
        params.push(tipo.toUpperCase());
        conditions.push(`l.tipo = $${params.length}::layout_tipo_enum`);
      }
      if (estado) {
        params.push(estado.toUpperCase());
        conditions.push(`l.estado = $${params.length}::layout_estado_enum`);
      }

      const where  = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const offset = (parseInt(page) - 1) * parseInt(limit);

      params.push(parseInt(limit), offset);

      const { rows } = await db(
        `SELECT
           l.id, l.periodo, l.numero_descuento, l.tipo,
           l.tipo_frecuencia, l.importe, l.estado,
           l.fecha_generacion, l.fecha_envio, l.fecha_confirmacion,
           l.referencia_bancaria, l.notas,
           -- Crédito
           c.id AS credito_id, c.monto_aprobado, c.plazo_meses,
           s.folio,
           -- Acreditado
           TRIM(CONCAT(p.nombres,' ',p.apellido_pat,' ',COALESCE(p.apellido_mat,''))) AS acreditado,
           p.curp, p.email, p.telefono,
           -- Empresa
           COALESCE(e.nombre,'Sin empresa') AS empresa,
           e.id AS empresa_id,
           -- Totales
           c.plazo_meses * (CASE l.tipo_frecuencia WHEN 'QUINCENAL' THEN 2 WHEN 'SEMANAL' THEN 4 ELSE 1 END) AS total_descuentos
         FROM layouts_nomina l
         JOIN creditos     c  ON c.id = l.credito_id
         JOIN solicitudes  s  ON s.id = c.solicitud_id
         JOIN solicitantes p  ON p.id = s.solicitante_id
         LEFT JOIN empresas e ON e.id = s.empresa_id
         ${where}
         ORDER BY e.nombre, p.apellido_pat, l.numero_descuento
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      // Totales para KPIs
      const countParams = params.slice(0, -2);
      const { rows: totales } = await db(
        `SELECT
           COUNT(*)                                           AS total,
           COUNT(*) FILTER (WHERE l.estado='PENDIENTE')      AS pendientes,
           COUNT(*) FILTER (WHERE l.estado='CONFIRMADO')     AS confirmados,
           COUNT(*) FILTER (WHERE l.estado='ENVIADO')        AS enviados,
           COALESCE(SUM(l.importe),0)                        AS importe_total,
           COALESCE(SUM(l.importe) FILTER (WHERE l.estado='CONFIRMADO'),0) AS importe_confirmado
         FROM layouts_nomina l
         JOIN creditos     c  ON c.id = l.credito_id
         JOIN solicitudes  s  ON s.id = c.solicitud_id
         LEFT JOIN empresas e ON e.id = s.empresa_id
         ${where}`,
        countParams
      );

      res.json({
        ok:      true,
        data:    rows,
        totales: totales[0],
      });
    } catch (err) { next(err); }
  }
);

/* ─────────────────────────────────────────────────────────────
   POST /api/v1/layouts/generar
   Genera automáticamente los registros de layout para un periodo.
   ───────────────────────────────────────────────────────────── */
router.post('/generar',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  body('periodo').matches(/^\d{4}-\d{2}$/).withMessage('Formato: YYYY-MM'),
  body('tipo').isIn(['DESCUENTO', 'RECUPERACION']),
  body('empresa_id').optional().isInt({ min: 1 }),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { periodo, tipo, empresa_id } = req.body;

      const { rows } = await db(
        `SELECT * FROM generar_layout_periodo($1, $2::layout_tipo_enum, $3)`,
        [periodo, tipo, empresa_id || null]
      );

      logger.info('Layout generado', { periodo, tipo, empresa_id, ...rows[0] });

      res.json({
        ok:      true,
        mensaje: `Layout generado: ${rows[0].insertados} nuevos, ${rows[0].ya_existian} ya existían.`,
        ...rows[0],
      });
    } catch (err) { next(err); }
  }
);

/* ─────────────────────────────────────────────────────────────
   PATCH /api/v1/layouts/:id/estado
   Cambia el estado de un registro (ENVIADO / CONFIRMADO / RECHAZADO).
   ───────────────────────────────────────────────────────────── */
router.patch('/:id/estado',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  param('id').isUUID(),
  body('estado').isIn(['ENVIADO', 'CONFIRMADO', 'RECHAZADO']),
  body('referencia_bancaria').optional().isString(),
  body('notas').optional().isString(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { estado, referencia_bancaria, notas } = req.body;

      const camposExtra = estado === 'ENVIADO'
        ? ', fecha_envio = NOW(), enviado_por = $4'
        : estado === 'CONFIRMADO'
        ? ', fecha_confirmacion = NOW(), confirmado_por = $4'
        : ', fecha_rechazo = NOW()';

      const { rows } = await db(
        `UPDATE layouts_nomina
         SET estado = $1::layout_estado_enum,
             referencia_bancaria = COALESCE($2, referencia_bancaria),
             notas = COALESCE($3, notas),
             updated_at = NOW()
             ${camposExtra}
         WHERE id = $${estado === 'RECHAZADO' ? '4' : '4'}
         RETURNING id, estado, folio`,
        estado === 'RECHAZADO'
          ? [estado, referencia_bancaria, notas, id]
          : [estado, referencia_bancaria, notas, req.user.id, id]
      );

      if (!rows.length) {
        return res.status(404).json({ ok: false, message: 'Layout no encontrado' });
      }

      logger.info('Estado de layout actualizado', { id, estado, usuario: req.user.email });
      res.json({ ok: true, layout: rows[0] });
    } catch (err) { next(err); }
  }
);

/* ─────────────────────────────────────────────────────────────
   PATCH /api/v1/layouts/confirmar-lote
   Confirma múltiples layouts en una sola operación (checkbox masivo).
   ───────────────────────────────────────────────────────────── */
router.patch('/confirmar-lote',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  body('ids').isArray({ min: 1 }),
  body('ids.*').isUUID(),
  body('referencia_bancaria').optional().isString(),
  handleValidationErrors,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { ids, referencia_bancaria } = req.body;

      const { rows } = await client.query(
        `UPDATE layouts_nomina
         SET estado               = 'CONFIRMADO',
             fecha_confirmacion   = NOW(),
             confirmado_por       = $1,
             referencia_bancaria  = COALESCE($2, referencia_bancaria),
             updated_at           = NOW()
         WHERE id = ANY($3::uuid[])
           AND estado != 'CONFIRMADO'
         RETURNING id, estado`,
        [req.user.id, referencia_bancaria || null, ids]
      );

      await client.query('COMMIT');

      logger.info('Lote de layouts confirmado', { cantidad: rows.length, usuario: req.user.email });
      res.json({
        ok:           true,
        confirmados:  rows.length,
        mensaje:      `${rows.length} pago(s) confirmados exitosamente`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/layouts/resumen/:periodo
   KPIs ejecutivos de un periodo para el dashboard de layouts.
   ───────────────────────────────────────────────────────────── */
router.get('/resumen/:periodo',
  authMiddleware,
  param('periodo').matches(/^\d{4}-\d{2}$/),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { periodo } = req.params;

      const { rows } = await db(
        `SELECT
           COUNT(*)                                               AS total_creditos,
           COUNT(DISTINCT s.empresa_id)                          AS empresas,
           COALESCE(SUM(l.importe),0)                            AS importe_total,
           COUNT(*) FILTER (WHERE l.estado='PENDIENTE')          AS pendientes,
           COUNT(*) FILTER (WHERE l.estado='ENVIADO')            AS enviados,
           COUNT(*) FILTER (WHERE l.estado='CONFIRMADO')         AS confirmados,
           COUNT(*) FILTER (WHERE l.estado='RECHAZADO')          AS rechazados,
           COALESCE(SUM(l.importe) FILTER (WHERE l.estado='CONFIRMADO'),0) AS importe_confirmado,
           COALESCE(SUM(l.importe) FILTER (WHERE l.estado='PENDIENTE'),0)  AS importe_pendiente
         FROM layouts_nomina l
         JOIN creditos    c  ON c.id = l.credito_id
         JOIN solicitudes s  ON s.id = c.solicitud_id
         WHERE l.periodo = $1`,
        [periodo]
      );

      // Detalle por empresa
      const { rows: porEmpresa } = await db(
        `SELECT
           COALESCE(e.nombre,'Sin empresa') AS empresa,
           COUNT(*)                          AS creditos,
           COALESCE(SUM(l.importe),0)        AS importe,
           COUNT(*) FILTER (WHERE l.estado='CONFIRMADO') AS pagados
         FROM layouts_nomina l
         JOIN creditos    c  ON c.id = l.credito_id
         JOIN solicitudes s  ON s.id = c.solicitud_id
         LEFT JOIN empresas e ON e.id = s.empresa_id
         WHERE l.periodo = $1
         GROUP BY e.nombre ORDER BY importe DESC`,
        [periodo]
      );

      res.json({ ok: true, resumen: rows[0], por_empresa: porEmpresa });
    } catch (err) { next(err); }
  }
);

/* ─────────────────────────────────────────────────────────────
   GET /api/v1/layouts/periodos
   Lista los periodos que tienen registros en la BD.
   ───────────────────────────────────────────────────────────── */
router.get('/periodos',
  authMiddleware,
  async (req, res, next) => {
    try {
      const { rows } = await db(
        `SELECT DISTINCT periodo,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE estado='CONFIRMADO') AS confirmados
         FROM layouts_nomina
         GROUP BY periodo ORDER BY periodo DESC LIMIT 24`
      );
      res.json({ ok: true, periodos: rows });
    } catch (err) { next(err); }
  }
);

module.exports = router;
