/**
 * expediente.js
 * API completa para el expediente digital de documentos de cada solicitud.
 *
 * Rutas:
 *   POST   /api/v1/expediente/:solicitudId/subir       → sube uno o varios archivos
 *   GET    /api/v1/expediente/:solicitudId             → lista documentos del expediente
 *   GET    /api/v1/expediente/:solicitudId/:docId/ver  → URL firmada para ver el archivo
 *   PATCH  /api/v1/expediente/:solicitudId/:docId/verificar → marcar como verificado
 *   DELETE /api/v1/expediente/:solicitudId/:docId      → eliminar documento
 *   GET    /api/v1/expediente/:solicitudId/resumen     → checklist de documentos
 */

const router  = require('express').Router({ mergeParams: true });
const multer  = require('multer');
const { param, body } = require('express-validator');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { query: db, pool }  = require('../config/db');
const storage  = require('../services/storageService');
const logger   = require('../config/logger');

// ── Multer: memoria (no disco) ────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: parseInt(process.env.UPLOAD_MAX_MB || '10') * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (storage.MIME_PERMITIDOS.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato no permitido. Solo JPG, PNG, WEBP o PDF.'));
    }
  },
});

// ── Documentos requeridos para aprobar un crédito ─────────────
const DOCS_REQUERIDOS = [
  { tipo: 'INE_FRENTE',           label: 'INE / IFE (frente)',           requerido: true  },
  { tipo: 'INE_REVERSO',          label: 'INE / IFE (reverso)',          requerido: true  },
  { tipo: 'COMPROBANTE_DOMICILIO',label: 'Comprobante de domicilio',     requerido: true  },
  { tipo: 'RECIBO_NOMINA',        label: 'Recibo de nómina (último)',    requerido: true  },
  { tipo: 'COMPROBANTE_INGRESOS', label: 'Comprobante de ingresos',      requerido: false },
  { tipo: 'CURP',                 label: 'CURP',                         requerido: false },
  { tipo: 'ESTADO_CUENTA',        label: 'Estado de cuenta bancario',    requerido: false },
];

// ── Helper: verificar que la solicitud existe ─────────────────
async function checkSolicitud(solicitudId) {
  const { rows } = await db(
    'SELECT id, folio, estado FROM solicitudes WHERE id=$1', [solicitudId]
  );
  return rows[0] || null;
}

// ════════════════════════════════════════════════════════════════
// POST /api/v1/expediente/:solicitudId/subir
// Sube uno o varios documentos. Acepta campo "archivos" (múltiple).
// Puede ser llamado SIN autenticación desde el sitio web público,
// O con autenticación desde el backoffice.
// ════════════════════════════════════════════════════════════════
router.post('/:solicitudId/subir',
  upload.array('archivos', 10),   // máximo 10 archivos por petición
  param('solicitudId').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ ok: false, message: 'No se recibieron archivos' });
    }

    const { solicitudId } = req.params;
    const tipos = Array.isArray(req.body.tipos)
      ? req.body.tipos
      : [req.body.tipo || 'OTRO'];

    const sol = await checkSolicitud(solicitudId);
    if (!sol) return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const resultados = [];

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const tipo = (tipos[i] || tipos[0] || 'OTRO').toUpperCase();

        // Subir a R2
        const { key, url, mimeType, sizeBytes } = await storage.upload({
          buffer:       file.buffer,
          mimeType:     file.mimetype,
          originalName: file.originalname,
          solicitudId,
          tipo,
        });

        // Guardar en BD
        const { rows } = await client.query(
          `INSERT INTO documentos
             (solicitud_id, tipo, nombre_archivo, url_storage, tamanio_bytes, mime_type)
           VALUES ($1, $2::tipo_doc_enum, $3, $4, $5, $6)
           RETURNING id, tipo, nombre_archivo, tamanio_bytes, created_at`,
          [solicitudId, tipo, file.originalname, url, sizeBytes, mimeType]
        );

        resultados.push(rows[0]);
      }

      await client.query('COMMIT');
      logger.info('Documentos subidos', { solicitudId, cantidad: resultados.length });

      res.status(201).json({
        ok: true,
        mensaje: `${resultados.length} documento(s) subido(s) exitosamente`,
        documentos: resultados,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      next(err);
    } finally {
      client.release();
    }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /api/v1/expediente/:solicitudId
// Lista todos los documentos del expediente.
// ════════════════════════════════════════════════════════════════
router.get('/:solicitudId',
  param('solicitudId').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { solicitudId } = req.params;

      const { rows } = await db(
        `SELECT
           d.id, d.tipo, d.nombre_archivo, d.url_storage,
           d.tamanio_bytes, d.mime_type,
           d.verificado, d.created_at,
           u.nombre AS verificado_por_nombre
         FROM documentos d
         LEFT JOIN usuarios_sistema u ON u.id = d.verificado_por
         WHERE d.solicitud_id = $1
         ORDER BY d.created_at DESC`,
        [solicitudId]
      );

      // Calcular checklist de completitud
      const tiposSubidos = new Set(rows.map(r => r.tipo));
      const checklist = DOCS_REQUERIDOS.map(doc => ({
        ...doc,
        subido:     tiposSubidos.has(doc.tipo),
        verificado: rows.find(r => r.tipo === doc.tipo)?.verificado || false,
        docId:      rows.find(r => r.tipo === doc.tipo)?.id || null,
      }));

      const completo = DOCS_REQUERIDOS
        .filter(d => d.requerido)
        .every(d => tiposSubidos.has(d.tipo));

      res.json({
        ok: true,
        documentos: rows,
        checklist,
        resumen: {
          total:       rows.length,
          verificados: rows.filter(r => r.verificado).length,
          completo,
        },
      });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /api/v1/expediente/:solicitudId/:docId/ver
// Genera URL firmada temporal (15 min) para ver el archivo.
// ════════════════════════════════════════════════════════════════
router.get('/:solicitudId/:docId/ver',
  param('solicitudId').isUUID(),
  param('docId').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { solicitudId, docId } = req.params;

      const { rows } = await db(
        'SELECT url_storage, mime_type, nombre_archivo FROM documentos WHERE id=$1 AND solicitud_id=$2',
        [docId, solicitudId]
      );

      if (!rows.length) return res.status(404).json({ ok: false, message: 'Documento no encontrado' });

      const key = storage.keyFromRef(rows[0].url_storage);
      const url = await storage.getPresignedUrl(key, 900); // 15 minutos

      res.json({
        ok:           true,
        url,
        mimeType:     rows[0].mime_type,
        nombreArchivo:rows[0].nombre_archivo,
        expiraEn:     '15 minutos',
      });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// PATCH /api/v1/expediente/:solicitudId/:docId/verificar
// Marca un documento como verificado (o lo desmarca).
// ════════════════════════════════════════════════════════════════
router.patch('/:solicitudId/:docId/verificar',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  param('solicitudId').isUUID(),
  param('docId').isUUID(),
  body('verificado').isBoolean(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { solicitudId, docId } = req.params;
      const { verificado } = req.body;

      const { rows } = await db(
        `UPDATE documentos
         SET verificado = $1,
             verificado_por = $2
         WHERE id=$3 AND solicitud_id=$4
         RETURNING id, tipo, verificado`,
        [verificado, verificado ? req.user.id : null, docId, solicitudId]
      );

      if (!rows.length) return res.status(404).json({ ok: false, message: 'Documento no encontrado' });

      logger.info('Documento verificado', { docId, verificado, usuario: req.user.email });
      res.json({ ok: true, documento: rows[0] });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// DELETE /api/v1/expediente/:solicitudId/:docId
// Elimina un documento del expediente (y de R2).
// ════════════════════════════════════════════════════════════════
router.delete('/:solicitudId/:docId',
  authMiddleware,
  requireRole('ADMIN', 'ANALISTA'),
  param('solicitudId').isUUID(),
  param('docId').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { solicitudId, docId } = req.params;

      const { rows } = await db(
        'SELECT url_storage FROM documentos WHERE id=$1 AND solicitud_id=$2',
        [docId, solicitudId]
      );

      if (!rows.length) return res.status(404).json({ ok: false, message: 'Documento no encontrado' });

      // Eliminar de R2
      const key = storage.keyFromRef(rows[0].url_storage);
      await storage.remove(key);

      // Eliminar de BD
      await db('DELETE FROM documentos WHERE id=$1', [docId]);

      logger.info('Documento eliminado', { docId, solicitudId });
      res.json({ ok: true, mensaje: 'Documento eliminado' });
    } catch (err) { next(err); }
  }
);

// ════════════════════════════════════════════════════════════════
// GET /api/v1/expediente/:solicitudId/checklist
// Resumen de qué documentos faltan para poder aprobar.
// ════════════════════════════════════════════════════════════════
router.get('/:solicitudId/checklist',
  param('solicitudId').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const { solicitudId } = req.params;
      const { rows } = await db(
        'SELECT tipo, verificado FROM documentos WHERE solicitud_id=$1', [solicitudId]
      );

      const tiposSubidos = new Set(rows.map(r => r.tipo));
      const checklist = DOCS_REQUERIDOS.map(d => ({
        ...d,
        subido:     tiposSubidos.has(d.tipo),
        verificado: rows.find(r => r.tipo === d.tipo)?.verificado || false,
      }));

      const faltantes = checklist.filter(d => d.requerido && !d.subido).map(d => d.label);
      const completo  = faltantes.length === 0;

      res.json({ ok: true, checklist, completo, faltantes });
    } catch (err) { next(err); }
  }
);

module.exports = router;
