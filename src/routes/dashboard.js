const router = require('express').Router();
const { query: db } = require('../config/db');
const { authMiddleware } = require('../middleware/auth');

/**
 * GET /api/v1/dashboard
 * KPIs principales para el backoffice.
 */
router.get('/', authMiddleware, async (_req, res, next) => {
  try {
    const [solicitudes, cartera, distribucion, recientes] = await Promise.all([

      // Totales por estado
      db(`SELECT estado, COUNT(*) AS total,
                 COALESCE(SUM(monto_solicitado),0) AS monto_total
          FROM solicitudes
          GROUP BY estado`),

      // Resumen de cartera activa
      db(`SELECT
            COUNT(*)                                        AS creditos_activos,
            COALESCE(SUM(monto_aprobado),0)                AS monto_total_desembolsado,
            COALESCE(SUM(saldo_insoluto),0)                AS saldo_por_cobrar,
            COALESCE(AVG(tasa_nominal_anual)*100,0)        AS tasa_promedio,
            COUNT(*) FILTER (WHERE estado='VENCIDO')       AS vencidos
          FROM creditos WHERE estado IN ('ACTIVO','VENCIDO')`),

      // Distribución de rankings
      db(`SELECT ranking, COUNT(*) AS total
          FROM evaluaciones GROUP BY ranking ORDER BY ranking`),

      // Últimas 5 solicitudes
      db(`SELECT s.folio, s.estado, s.monto_solicitado, s.tipo_credito,
                 s.fecha_solicitud,
                 CONCAT(p.nombres,' ',p.apellido_pat) AS nombre,
                 ev.ranking
          FROM solicitudes s
          JOIN solicitantes p ON p.id = s.solicitante_id
          LEFT JOIN evaluaciones ev ON ev.solicitud_id = s.id
          ORDER BY s.created_at DESC LIMIT 5`),
    ]);

    res.json({
      ok: true,
      solicitudes: solicitudes.rows,
      cartera:     cartera.rows[0],
      rankings:    distribucion.rows,
      recientes:   recientes.rows,
    });
  } catch (err) { next(err); }
});

module.exports = router;
