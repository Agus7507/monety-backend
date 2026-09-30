BEGIN;

CREATE TABLE IF NOT EXISTS requisitos_documentales (
    id SERIAL PRIMARY KEY,

    tipo tipo_doc_enum NOT NULL,

    nombre VARCHAR(150) NOT NULL,

    descripcion TEXT,

    obligatorio BOOLEAN NOT NULL DEFAULT TRUE,

    permite_pdf BOOLEAN NOT NULL DEFAULT TRUE,

    permite_imagen BOOLEAN NOT NULL DEFAULT TRUE,

    activo BOOLEAN NOT NULL DEFAULT TRUE,

    orden SMALLINT NOT NULL DEFAULT 100,

    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT requisitos_documentales_tipo_key
        UNIQUE (tipo),

    CONSTRAINT requisitos_documentales_orden_check
        CHECK (orden > 0)
);

INSERT INTO requisitos_documentales (
    tipo,
    nombre,
    descripcion,
    obligatorio,
    permite_pdf,
    permite_imagen,
    orden
)
VALUES
    (
        'INE_FRENTE',
        'Identificación oficial, frente',
        'Carga la parte frontal de tu INE o IFE vigente.',
        TRUE,
        TRUE,
        TRUE,
        10
    ),
    (
        'INE_REVERSO',
        'Identificación oficial, reverso',
        'Carga la parte posterior de tu INE o IFE vigente.',
        TRUE,
        TRUE,
        TRUE,
        20
    ),
    (
        'CURP',
        'CURP',
        'Carga tu constancia de CURP.',
        TRUE,
        TRUE,
        TRUE,
        30
    ),
    (
        'RFC',
        'RFC',
        'Carga un documento donde sea visible tu RFC.',
        TRUE,
        TRUE,
        TRUE,
        40
    ),
    (
        'COMPROBANTE_DOMICILIO',
        'Comprobante de domicilio',
        'Carga un comprobante de domicilio reciente.',
        TRUE,
        TRUE,
        TRUE,
        50
    ),
    (
        'RECIBO_NOMINA',
        'Recibo de nómina',
        'Carga tu recibo de nómina más reciente.',
        TRUE,
        TRUE,
        TRUE,
        60
    ),
    (
        'ESTADO_CUENTA',
        'Estado de cuenta bancario',
        'Carga un estado de cuenta donde pueda validarse la cuenta bancaria.',
        TRUE,
        TRUE,
        FALSE,
        70
    ),
    (
        'CONSTANCIA_SAT',
        'Constancia de situación fiscal',
        'Carga tu constancia de situación fiscal vigente.',
        TRUE,
        TRUE,
        FALSE,
        80
    )
ON CONFLICT (tipo)
DO UPDATE SET
    nombre = EXCLUDED.nombre,
    descripcion = EXCLUDED.descripcion,
    obligatorio = EXCLUDED.obligatorio,
    permite_pdf = EXCLUDED.permite_pdf,
    permite_imagen = EXCLUDED.permite_imagen,
    orden = EXCLUDED.orden,
    activo = TRUE;

ALTER TABLE documentos
    ADD COLUMN IF NOT EXISTS estado VARCHAR(20)
        NOT NULL DEFAULT 'CARGADO',

    ADD COLUMN IF NOT EXISTS observaciones TEXT,

    ADD COLUMN IF NOT EXISTS fecha_verificacion TIMESTAMPTZ,

    ADD COLUMN IF NOT EXISTS origen VARCHAR(20)
        NOT NULL DEFAULT 'BACKOFFICE',

    ADD COLUMN IF NOT EXISTS documento_anterior_id UUID,

    ADD COLUMN IF NOT EXISTS activo BOOLEAN
        NOT NULL DEFAULT TRUE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'documentos_estado_check'
    ) THEN
        ALTER TABLE documentos
            ADD CONSTRAINT documentos_estado_check
            CHECK (
                estado IN (
                    'CARGADO',
                    'EN_REVISION',
                    'APROBADO',
                    'RECHAZADO',
                    'REEMPLAZADO'
                )
            );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'documentos_origen_check'
    ) THEN
        ALTER TABLE documentos
            ADD CONSTRAINT documentos_origen_check
            CHECK (
                origen IN (
                    'PORTAL',
                    'BACKOFFICE'
                )
            );
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'documentos_anterior_fkey'
    ) THEN
        ALTER TABLE documentos
            ADD CONSTRAINT documentos_anterior_fkey
            FOREIGN KEY (documento_anterior_id)
            REFERENCES documentos(id)
            ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_documentos_solicitud_tipo_activo
    ON documentos (
        solicitud_id,
        tipo,
        activo
    );

CREATE INDEX IF NOT EXISTS idx_documentos_estado
    ON documentos (estado);

COMMIT;
