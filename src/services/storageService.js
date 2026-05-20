/**
 * storageService.js
 * Abstracción para subir, obtener y eliminar archivos en Cloudflare R2.
 * R2 es compatible con la API de AWS S3 — usa @aws-sdk/client-s3.
 *
 * Variables de entorno requeridas:
 *   R2_ACCOUNT_ID     → ID de tu cuenta Cloudflare (Settings → Account ID)
 *   R2_ACCESS_KEY_ID  → R2 API Token (Access Key ID)
 *   R2_SECRET_KEY     → R2 API Token (Secret Access Key)
 *   R2_BUCKET         → Nombre del bucket (ej: monety-docs)
 *   R2_PUBLIC_URL     → URL pública del bucket (ej: https://docs.monety.mx)
 *                       Si no tienes dominio personalizado puedes dejarlo vacío
 *                       y se usará la URL firmada temporal.
 */

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 }   = require('uuid');
const path             = require('path');
const logger           = require('../config/logger');

// ── Cliente R2 ────────────────────────────────────────────────
let r2Client = null;

function getClient() {
  if (r2Client) return r2Client;

  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error('R2_ACCOUNT_ID no configurado en .env');

  r2Client = new S3Client({
    region:   'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_KEY,
    },
  });

  return r2Client;
}

const BUCKET = () => process.env.R2_BUCKET || 'monety-docs';

// ── Tipos de documento permitidos ────────────────────────────
const TIPOS_VALIDOS = new Set([
  'INE_FRENTE', 'INE_REVERSO', 'CURP', 'RFC',
  'COMPROBANTE_DOMICILIO', 'COMPROBANTE_INGRESOS',
  'RECIBO_NOMINA', 'ESTADO_CUENTA', 'CONTRATO_LABORAL',
  'CONTRATO_CREDITO', 'OTRO',
]);

const MIME_PERMITIDOS = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'application/pdf',
]);

const MAX_BYTES = parseInt(process.env.UPLOAD_MAX_MB || '10') * 1024 * 1024;

// ── Extensión → mime ──────────────────────────────────────────
function mimeFromBuffer(buffer) {
  // Detecta por magic bytes
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer.slice(0, 4).toString() === '%PDF')  return 'application/pdf';
  return null;
}

/**
 * Sube un archivo a R2.
 *
 * @param {object} opts
 * @param {Buffer}  opts.buffer       — contenido del archivo
 * @param {string}  opts.mimeType     — MIME type
 * @param {string}  opts.originalName — nombre original del archivo
 * @param {string}  opts.solicitudId  — UUID de la solicitud
 * @param {string}  opts.tipo         — tipo_doc_enum: 'INE_FRENTE', 'CURP', etc.
 * @returns {Promise<{key, url, mimeType, sizeBytes}>}
 */
async function upload({ buffer, mimeType, originalName, solicitudId, tipo }) {
  if (!TIPOS_VALIDOS.has(tipo))
    throw new Error(`Tipo de documento inválido: ${tipo}`);

  if (!MIME_PERMITIDOS.has(mimeType))
    throw new Error('Solo se permiten archivos JPG, PNG, WEBP o PDF');

  if (buffer.length > MAX_BYTES)
    throw new Error(`El archivo supera el límite de ${process.env.UPLOAD_MAX_MB || 10} MB`);

  const ext = path.extname(originalName) || (mimeType === 'application/pdf' ? '.pdf' : '.jpg');
  const key = `solicitudes/${solicitudId}/${tipo}_${uuidv4()}${ext}`;

  await getClient().send(new PutObjectCommand({
    Bucket:      BUCKET(),
    Key:         key,
    Body:        buffer,
    ContentType: mimeType,
    Metadata: {
      solicitudId,
      tipo,
      originalName: Buffer.from(originalName).toString('base64'),
    },
    // Privado por defecto — acceso solo por URL firmada
    ACL: 'private',
  }));

  logger.info('Archivo subido a R2', { key, sizeBytes: buffer.length, tipo });

  return {
    key,
    url:       buildStorageRef(key),   // referencia interna (no URL pública directa)
    mimeType,
    sizeBytes: buffer.length,
  };
}

/**
 * Genera una URL firmada temporal para ver/descargar un archivo privado.
 * Expira en `expiresIn` segundos (default: 15 minutos).
 */
async function getPresignedUrl(key, expiresIn = 900) {
  // Si el bucket tiene URL pública configurada, úsala directamente
  if (process.env.R2_PUBLIC_URL) {
    return `${process.env.R2_PUBLIC_URL}/${key}`;
  }

  const url = await getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: BUCKET(), Key: key }),
    { expiresIn }
  );
  return url;
}

/**
 * Elimina un archivo de R2.
 */
async function remove(key) {
  await getClient().send(new DeleteObjectCommand({
    Bucket: BUCKET(),
    Key:    key,
  }));
  logger.info('Archivo eliminado de R2', { key });
}

/**
 * Verifica si un archivo existe en R2.
 */
async function exists(key) {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: BUCKET(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Referencia de almacenamiento interna (lo que se guarda en la BD).
 * Formato: r2://<bucket>/<key>
 */
function buildStorageRef(key) {
  return `r2://${BUCKET()}/${key}`;
}

/**
 * Extrae el key de una referencia de almacenamiento.
 */
function keyFromRef(ref) {
  return ref.replace(/^r2:\/\/[^/]+\//, '');
}

module.exports = { upload, getPresignedUrl, remove, exists, keyFromRef, TIPOS_VALIDOS, MIME_PERMITIDOS };
