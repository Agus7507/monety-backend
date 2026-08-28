-- ============================================================
--  MIGRACIÓN: Agregar CONSTANCIA_SAT al tipo de documentos
--  Ejecutar en pgAdmin → Query Tool conectado a RDS PostgreSQL
-- ============================================================

-- 1. Ver la restricción actual
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'documentos'::regclass AND contype = 'c';

-- 2. Eliminar la restricción anterior de tipo
ALTER TABLE documentos DROP CONSTRAINT IF EXISTS documentos_tipo_check;

-- 3. Agregar la nueva restricción incluyendo CONSTANCIA_SAT
ALTER TABLE documentos
  ADD CONSTRAINT documentos_tipo_check
  CHECK (tipo IN (
    'INE_FRENTE', 'INE_REVERSO', 'CURP', 'RFC',
    'COMPROBANTE_DOMICILIO', 'COMPROBANTE_INGRESOS',
    'RECIBO_NOMINA', 'ESTADO_CUENTA',
    'CONSTANCIA_SAT',
    'CONTRATO_LABORAL', 'CONTRATO_CREDITO', 'OTRO'
  ));

-- Verificar
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'documentos'::regclass AND contype = 'c';
