const logger = require('../config/logger');

/** Maneja errores de validación de express-validator */
function handleValidationErrors(req, res, next) {
  const { validationResult } = require('express-validator');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      ok: false,
      message: 'Datos de entrada inválidos',
      errors: errors.array().map(e => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

/** Middleware global de errores — va al final del app */
function globalErrorHandler(err, req, res, next) {
  logger.error('Error no controlado', {
    message: err.message,
    stack:   err.stack,
    url:     req.originalUrl,
    method:  req.method,
  });

  // Error de unicidad PostgreSQL (email, CURP, etc.)
  if (err.code === '23505') {
    const field = err.detail?.match(/Key \((.+)\)/)?.[1] || 'campo';
    return res.status(409).json({ ok: false, message: `Ya existe un registro con ese ${field}` });
  }

  // FK violation
  if (err.code === '23503') {
    return res.status(400).json({ ok: false, message: 'Referencia inválida en los datos enviados' });
  }

  const status  = err.statusCode || err.status || 500;
  const message = status < 500 ? err.message : 'Error interno del servidor';
  res.status(status).json({ ok: false, message });
}

module.exports = { handleValidationErrors, globalErrorHandler };
