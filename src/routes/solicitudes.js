const router   = require('express').Router();
const { body, param, query: qVal } = require('express-validator');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { authMiddleware, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/solicitudesController');

/* ── Validaciones reutilizables ── */
const validarSolicitud = [
  // Datos personales
  body('nombres').trim().notEmpty().withMessage('Nombres requeridos'),
  body('apellidoPat').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('telefono').isMobilePhone('es-MX').withMessage('Teléfono MX inválido'),
  body('curp').optional().matches(/^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/i).withMessage('CURP inválido'),

  // Datos laborales
  body('empresaId').isInt({ min: 1 }),
  body('tipoNomina').isIn(['MENSUAL', 'QUINCENAL', 'SEMANAL']),
  body('fechaIngresoEmp').isISO8601().toDate(),
  body('fechaBajaEstim').isISO8601().toDate(),
  body('salarioBruto').isFloat({ min: 1 }),
  body('salarioNeto').isFloat({ min: 1 }),
  body('historialCrediticio').isIn(['EXCELENTE', 'MUY_BUENO', 'BUENO', 'MEDIO_BAJO']),

  // Datos del crédito
  body('tipoCredito').isIn(['NOMINA', 'PERSONAL']),
  body('montoSolicitado').isFloat({ min: 3000, max: 80000 }),
  body('plazoMeses').isInt({ min: 3, max: 36 }),
  body('gastos').optional().isFloat({ min: 0 }),
  body('tieneDeudas').optional().isBoolean(),
  body('pagoMensualDeudas').optional().isFloat({ min: 0 }),
];

/* ── Rutas públicas ─────────────────────────────────── */

/**
 * POST /api/v1/solicitudes
 * El formulario del sitio web envía aquí la solicitud completa.
 * Retorna el folio generado y el resultado de la evaluación automática.
 */
router.post('/',
  validarSolicitud,
  handleValidationErrors,
  ctrl.crear
);

/**
 * GET /api/v1/solicitudes/estado/:folio
 * El solicitante consulta el estado de su solicitud con su folio.
 * No requiere autenticación.
 */
router.get('/estado/:folio',
  param('folio').matches(/^MNT-\d{6}$/),
  handleValidationErrors,
  ctrl.consultarEstado
);

/* ── Rutas internas (requieren JWT) ─────────────────── */

/**
 * GET /api/v1/solicitudes
 * Lista paginada con filtros por estado, empresa, fecha.
 */
router.get('/',
  authMiddleware,
  ctrl.listar
);

/**
 * GET /api/v1/solicitudes/:id
 * Detalle completo de una solicitud.
 */
router.get('/:id',
  authMiddleware,
  param('id').isUUID(),
  handleValidationErrors,
  ctrl.obtener
);

/**
 * PATCH /api/v1/solicitudes/:id/estado
 * Cambia el estado de una solicitud (solo ADMIN o ANALISTA).
 */
router.patch('/:id/estado',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  param('id').isUUID(),
  body('estado').isIn(['PENDIENTE','EN_REVISION','PRE_APROBADA','APROBADA','RECHAZADA','CANCELADA']),
  body('comentario').optional().isString(),
  handleValidationErrors,
  ctrl.cambiarEstado
);

/**
 * POST /api/v1/solicitudes/:id/evaluar
 * Ejecuta (o re-ejecuta) el scoring crediticio.
 */
router.post('/:id/evaluar',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  param('id').isUUID(),
  handleValidationErrors,
  ctrl.evaluar
);

module.exports = router;
