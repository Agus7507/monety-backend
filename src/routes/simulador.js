const router   = require('express').Router();
const { body } = require('express-validator');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { evaluar, generarAmortizacion } = require('../services/scoringService');

/**
 * POST /api/v1/simulador
 * Endpoint público: calcula pago mensual, CAT y tabla de amortización.
 * El sitio web lo llama en tiempo real desde el simulador interactivo.
 */
router.post('/',
  body('monto').isFloat({ min: 3000, max: 80000 }).withMessage('Monto entre $3,000 y $80,000'),
  body('plazo').isInt({ min: 3, max: 36 }).withMessage('Plazo entre 3 y 36 meses'),
  body('tipoCredito').isIn(['NOMINA', 'PERSONAL']).withMessage('Tipo inválido'),
  handleValidationErrors,
  (req, res) => {
    const { monto, plazo, tipoCredito = 'NOMINA' } = req.body;

    const tasaMensual = tipoCredito === 'NOMINA' ? 0.043 : 0.05;
    const tasaConIva  = tasaMensual * 1.16;

    const pagoMensual = monto *
      (tasaConIva * Math.pow(1 + tasaConIva, plazo)) /
      (Math.pow(1 + tasaConIva, plazo) - 1);

    const cat       = tipoCredito === 'NOMINA' ? 0.59856 : 0.72;
    const tasaAnual = tasaMensual * 12;

    const tabla = generarAmortizacion({ monto, plazo, tipoCredito });

    res.json({
      ok: true,
      resultado: {
        monto,
        plazo,
        tipoCredito,
        tasaMensual:  Math.round(tasaMensual * 10000) / 10000,
        tasaAnual:    Math.round(tasaAnual  * 10000) / 10000,
        cat,
        pagoMensual:  Math.round(pagoMensual * 100) / 100,
        totalPagar:   Math.round(pagoMensual * plazo * 100) / 100,
        totalIntereses: Math.round((pagoMensual * plazo - monto) * 100) / 100,
      },
      tablaAmortizacion: tabla,
    });
  }
);

module.exports = router;
