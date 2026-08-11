-- ============================================================
--  MIGRACIÓN: Portal del Solicitante
--  Agrega columnas de autenticación a la tabla solicitantes
--  Ejecutar en pgAdmin → Query Tool conectado a Railway
-- ============================================================

ALTER TABLE solicitantes
  ADD COLUMN IF NOT EXISTS portal_password_hash TEXT,
  ADD COLUMN IF NOT EXISTS portal_activo         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS portal_ultimo_acceso  TIMESTAMPTZ;

COMMENT ON COLUMN solicitantes.portal_password_hash IS 'Hash bcrypt de la contraseña del portal del solicitante';
COMMENT ON COLUMN solicitantes.portal_activo        IS 'TRUE cuando el solicitante ha creado su cuenta en el portal';
COMMENT ON COLUMN solicitantes.portal_ultimo_acceso IS 'Último inicio de sesión en el portal';

-- Índice para acelerar el login por email
CREATE INDEX IF NOT EXISTS idx_solicitantes_portal_activo
  ON solicitantes (email, portal_activo)
  WHERE portal_activo = TRUE;
