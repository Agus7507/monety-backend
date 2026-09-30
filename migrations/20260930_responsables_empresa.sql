BEGIN;

ALTER TABLE empresas
ADD COLUMN IF NOT EXISTS id_sociedad VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS empresas_id_sociedad_uq
ON empresas(id_sociedad)
WHERE id_sociedad IS NOT NULL;

UPDATE empresas
SET id_sociedad = CASE nombre
    WHEN 'BINOMIA' THEN '101001'
    WHEN 'ZINAPZIA' THEN '101002'
    WHEN 'VIVA HEALTHY' THEN '101003'
    WHEN 'ACHEME' THEN '201001'
    ELSE id_sociedad
END
WHERE nombre IN (
    'BINOMIA',
    'ZINAPZIA',
    'VIVA HEALTHY',
    'ACHEME'
);

CREATE TABLE IF NOT EXISTS responsables_empresa (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    empresa_id INTEGER NOT NULL,

    nombre VARCHAR(180) NOT NULL,

    area VARCHAR(180) NOT NULL,

    puesto VARCHAR(180),

    email VARCHAR(180),

    firma_carta BOOLEAN NOT NULL DEFAULT TRUE,

    firma_contrato BOOLEAN NOT NULL DEFAULT TRUE,

    activo BOOLEAN NOT NULL DEFAULT TRUE,

    actualizado_por UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT responsables_empresa_empresa_fkey
        FOREIGN KEY (empresa_id)
        REFERENCES empresas(id)
        ON DELETE CASCADE,

    CONSTRAINT responsables_empresa_usuario_fkey
        FOREIGN KEY (actualizado_por)
        REFERENCES usuarios_sistema(id)
        ON DELETE SET NULL,

    CONSTRAINT responsables_empresa_nombre_check
        CHECK (LENGTH(TRIM(nombre)) >= 3),

    CONSTRAINT responsables_empresa_area_check
        CHECK (LENGTH(TRIM(area)) >= 3),

    CONSTRAINT responsables_empresa_alcance_check
        CHECK (
            firma_carta = TRUE
            OR firma_contrato = TRUE
        )
);

CREATE INDEX IF NOT EXISTS idx_responsables_empresa_empresa
ON responsables_empresa(empresa_id);

CREATE INDEX IF NOT EXISTS idx_responsables_empresa_activo
ON responsables_empresa(empresa_id, activo);

CREATE UNIQUE INDEX IF NOT EXISTS responsables_empresa_activo_uq
ON responsables_empresa(empresa_id)
WHERE activo = TRUE;

CREATE OR REPLACE FUNCTION set_responsables_empresa_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_upd_responsables_empresa
ON responsables_empresa;

CREATE TRIGGER trg_upd_responsables_empresa
BEFORE UPDATE ON responsables_empresa
FOR EACH ROW
EXECUTE FUNCTION set_responsables_empresa_updated_at();

COMMIT;
