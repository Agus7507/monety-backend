const router = require('express').Router();
const { body, param } = require('express-validator');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { query: db, pool } = require('../config/db');
const { generarAmortizacion } = require('../services/scoringService');
const logger = require('../config/logger');

/**
 * POST /api/v1/creditos
 * Formaliza un crédito a partir de una solicitud aprobada.
 * Genera e inserta la tabla de amortización completa.
 */
router.post('/',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  body('solicitudId').isUUID(),
  body('montoAprobado').isFloat({ min: 1 }),
  body('plazoMeses').isInt({ min: 3, max: 36 }),
  body('tasaNominalMensual').isFloat({ min: 0.001 }),
  body('fechaDesembolso').isISO8601().toDate(),
  handleValidationErrors,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const {
        solicitudId, montoAprobado, plazoMeses,
        tasaNominalMensual, fechaDesembolso,
        comisionApertura = 0, cuotaAdministracion = 0,
        seguroDesempleo = 0,
      } = req.body;

      // Verificar que la solicitud esté pre-aprobada
      const { rows: solRows } = await client.query(
        `SELECT s.id, s.tipo_credito, ev.id AS eval_id
         FROM solicitudes s
         JOIN evaluaciones ev ON ev.solicitud_id = s.id
         WHERE s.id=$1 AND s.estado='PRE_APROBADA' AND ev.resultado='APROBADO'`,
        [solicitudId]
      );
      if (!solRows.length) {
        return res.status(400).json({
          ok: false,
          message: 'La solicitud no está en estado PRE_APROBADA o no fue aprobada',
        });
      }
      const { eval_id, tipo_credito } = solRows[0];

      const iva            = 0.16;
      const tasaConIva     = tasaNominalMensual * (1 + iva);
      const tasaAnual      = tasaNominalMensual * 12;
      const cat            = tipo_credito === 'NOMINA' ? 0.59856 : 0.72;

      const pagoMensual = montoAprobado *
        (tasaConIva * Math.pow(1 + tasaConIva, plazoMeses)) /
        (Math.pow(1 + tasaConIva, plazoMeses) - 1);

      const pagoTotal      = pagoMensual + cuotaAdministracion + seguroDesempleo;
      const totalIntereses = (pagoMensual * plazoMeses) - montoAprobado;
      const totalIva       = totalIntereses * iva;
      const totalPagar     = montoAprobado + totalIntereses + totalIva;

      const vencimiento = new Date(fechaDesembolso);
      vencimiento.setMonth(vencimiento.getMonth() + plazoMeses);

      // Insertar el crédito
      const { rows: cRows } = await client.query(
        `INSERT INTO creditos
           (solicitud_id, evaluacion_id,
            monto_aprobado, plazo_meses,
            tasa_nominal_mensual, tasa_nominal_anual, cat_anual, iva,
            comision_apertura, cuota_administracion, seguro_desempleo,
            pago_mensual_capital_interes, pago_mensual_total,
            total_intereses, total_iva, monto_total_pagar,
            saldo_insoluto, fecha_desembolso, fecha_vencimiento)
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [solicitudId, eval_id,
         montoAprobado, plazoMeses,
         tasaNominalMensual, tasaAnual, cat, iva,
         comisionApertura, cuotaAdministracion, seguroDesempleo,
         Math.round(pagoMensual * 100) / 100,
         Math.round(pagoTotal  * 100) / 100,
         Math.round(totalIntereses * 100) / 100,
         Math.round(totalIva       * 100) / 100,
         Math.round(totalPagar     * 100) / 100,
         montoAprobado,
         fechaDesembolso,
         vencimiento.toISOString().slice(0, 10)]
      );
      const creditoId = cRows[0].id;

      // Generar e insertar tabla de amortización
      const tabla = generarAmortizacion({
        monto:       montoAprobado,
        plazo:       plazoMeses,
        tipoCredito: tipo_credito,
        fechaInicio: fechaDesembolso,
      });

      for (const row of tabla) {
        await client.query(
          `INSERT INTO amortizacion
             (credito_id, periodo, fecha_pago, saldo_inicial,
              capital, interes, iva, cuota_administracion, seguro,
              pago_fijo, pago_total, saldo_insoluto)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [creditoId, row.periodo, row.fechaPago, row.saldoInicial,
           row.capital, row.interes, row.iva,
           cuotaAdministracion, seguroDesempleo,
           row.pagoFijo, row.pagoTotal, row.saldoInsoluto]
        );
      }

      // Marcar solicitud como APROBADA
      await client.query(
        `UPDATE solicitudes SET estado='APROBADA', updated_at=NOW() WHERE id=$1`,
        [solicitudId]
      );

      await client.query('COMMIT');
      logger.info('Crédito formalizado', { creditoId, solicitudId });

      res.status(201).json({
        ok: true,
        creditoId,
        resumen: {
          montoAprobado, plazoMeses, tasaNominalAnual: tasaAnual,
          cat, pagoMensual: Math.round(pagoMensual * 100) / 100,
          totalPagar: Math.round(totalPagar * 100) / 100,
          fechaDesembolso, fechaVencimiento: vencimiento.toISOString().slice(0, 10),
        },
        tablaAmortizacion: tabla,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

/**
 * GET /api/v1/creditos
 * Cartera activa con filtros opcionales.
 */
router.get('/',
  authMiddleware,
  async (req, res, next) => {
    try {
      const { estado = 'ACTIVO', page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      const { rows } = await db(
        `SELECT c.id, s.folio, c.monto_aprobado, c.plazo_meses,
                c.tasa_nominal_anual, c.cat_anual, c.pago_mensual_total,
                c.saldo_insoluto, c.fecha_desembolso, c.fecha_vencimiento,
                c.estado, c.dias_vencido,
                CONCAT(p.nombres,' ',p.apellido_pat) AS acreditado,
                e.nombre AS empresa
         FROM creditos c
         JOIN solicitudes  s  ON s.id = c.solicitud_id
         JOIN solicitantes p  ON p.id = s.solicitante_id
         JOIN empresas     e  ON e.id = s.empresa_id
         WHERE c.estado = $1
         ORDER BY c.created_at DESC
         LIMIT $2 OFFSET $3`,
        [estado, parseInt(limit), offset]
      );
      res.json({ ok: true, data: rows });
    } catch (err) { next(err); }
  }
);

/**
 * GET /api/v1/creditos/:id/amortizacion
 * Tabla de amortización de un crédito.
 */
router.get('/:id/amortizacion',
  authMiddleware,
  param('id').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { rows } = await db(
        `SELECT periodo, fecha_pago, saldo_inicial, capital, interes,
                iva, pago_fijo, pago_total, saldo_insoluto, pagado, fecha_pago_real
         FROM amortizacion WHERE credito_id=$1 ORDER BY periodo`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ ok: false, message: 'Crédito no encontrado' });
      }
      res.json({ ok: true, tablaAmortizacion: rows });
    } catch (err) { next(err); }
  }
);

/**
 * PATCH /api/v1/creditos/:id/pago/:periodo
 * Registrar el pago de un periodo específico.
 */
router.patch('/:id/pago/:periodo',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  param('id').isUUID(),
  param('periodo').isInt({ min: 1 }),
  body('montoPagado').isFloat({ min: 0 }),
  body('fechaPagoReal').isISO8601().toDate(),
  handleValidationErrors,
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { id, periodo } = req.params;
      const { montoPagado, fechaPagoReal } = req.body;

      const { rows } = await client.query(
        `UPDATE amortizacion
         SET pagado=TRUE, monto_pagado=$1, fecha_pago_real=$2
         WHERE credito_id=$3 AND periodo=$4 AND pagado=FALSE
         RETURNING capital, saldo_insoluto`,
        [montoPagado, fechaPagoReal, id, periodo]
      );

      if (!rows.length) {
        return res.status(400).json({
          ok: false, message: 'Periodo no encontrado o ya pagado',
        });
      }

      // Actualizar saldo insoluto del crédito
      await client.query(
        `UPDATE creditos SET saldo_insoluto = saldo_insoluto - $1,
         updated_at=NOW() WHERE id=$2`,
        [rows[0].capital, id]
      );

      await client.query('COMMIT');
      res.json({ ok: true, message: `Pago del periodo ${periodo} registrado` });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

module.exports = router;
