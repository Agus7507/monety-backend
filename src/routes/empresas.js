const router = require('express').Router();
const { query: db } = require('../config/db');
const { authMiddleware, requireRole } = require('../middleware/auth');

/**
 * GET /api/v1/empresas
 * Lista empresas activas (público — necesario para llenar el formulario).
 */
router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await db(
      'SELECT id, nombre FROM empresas WHERE activa=TRUE ORDER BY nombre'
    );
    res.json({ ok: true, empresas: rows });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/empresas/:id/solicitudes
 * Solicitudes de una empresa específica (solo uso interno).
 */
router.get('/:id/solicitudes',
  authMiddleware,
  async (req, res, next) => {
    try {
      const { rows } = await db(
        `SELECT s.folio, s.estado, s.fecha_solicitud,
                s.monto_solicitado, s.tipo_credito,
                CONCAT(p.nombres,' ',p.apellido_pat) AS acreditado,
                ev.ranking, ev.resultado
         FROM solicitudes s
         JOIN solicitantes p  ON p.id = s.solicitante_id
         LEFT JOIN evaluaciones ev ON ev.solicitud_id = s.id
         WHERE s.empresa_id=$1
         ORDER BY s.created_at DESC`,
        [req.params.id]
      );
      res.json({ ok: true, data: rows });
    } catch (err) { next(err); }
  }
);

module.exports = router;
