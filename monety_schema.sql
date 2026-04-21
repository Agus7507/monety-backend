-- ============================================================
--  MONETY — Esquema PostgreSQL v1.0
--  Préstamos de Nómina y Personales
-- ============================================================

-- Extensiones requeridas
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TIPOS ENUMERADOS
-- ============================================================

CREATE TYPE tipo_credito_enum     AS ENUM ('NOMINA', 'PERSONAL');
CREATE TYPE tipo_nomina_enum      AS ENUM ('MENSUAL', 'QUINCENAL', 'SEMANAL');
CREATE TYPE historial_enum        AS ENUM ('EXCELENTE', 'MUY_BUENO', 'BUENO', 'MEDIO_BAJO');
CREATE TYPE estado_solicitud_enum AS ENUM ('PENDIENTE', 'EN_REVISION', 'PRE_APROBADA', 'APROBADA', 'RECHAZADA', 'CANCELADA');
CREATE TYPE estado_credito_enum   AS ENUM ('ACTIVO', 'PAGADO', 'VENCIDO', 'REESTRUCTURADO', 'CANCELADO');
CREATE TYPE ranking_enum          AS ENUM ('AAA', 'AA', 'A', 'BB', 'B', 'C', 'D', 'E');
CREATE TYPE rol_usuario_enum      AS ENUM ('ADMIN', 'AGENTE', 'ANALISTA');
CREATE TYPE tipo_doc_enum         AS ENUM (
    'INE_FRENTE', 'INE_REVERSO', 'CURP', 'RFC',
    'COMPROBANTE_DOMICILIO', 'COMPROBANTE_INGRESOS',
    'RECIBO_NOMINA', 'ESTADO_CUENTA', 'CONTRATO_LABORAL',
    'CONTRATO_CREDITO', 'OTRO'
);

-- ============================================================
-- 1. EMPRESAS
-- ============================================================

CREATE TABLE empresas (
    id              SERIAL PRIMARY KEY,
    nombre          VARCHAR(120) NOT NULL UNIQUE,
    rfc             VARCHAR(13),
    contacto_nombre VARCHAR(100),
    contacto_email  VARCHAR(150),
    contacto_tel    VARCHAR(15),
    activa          BOOLEAN      NOT NULL DEFAULT TRUE,
    convenio_desde  DATE,
    notas           TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE empresas IS 'Empresas con convenio para crédito de nómina';

INSERT INTO empresas (nombre) VALUES
    ('BINOMIA'), ('ZINAPZIA'), ('VIVA HEALTHY'), ('ACHEME'), ('OTRA');

-- ============================================================
-- 2. USUARIOS DEL SISTEMA  (agentes / analistas / admins)
-- ============================================================

CREATE TABLE usuarios_sistema (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre          VARCHAR(80)  NOT NULL,
    apellidos       VARCHAR(120) NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    password_hash   TEXT         NOT NULL,
    rol             rol_usuario_enum NOT NULL DEFAULT 'AGENTE',
    activo          BOOLEAN      NOT NULL DEFAULT TRUE,
    ultimo_acceso   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE usuarios_sistema IS 'Operadores internos con acceso al backoffice';

-- ============================================================
-- 3. SOLICITANTES  (personas físicas)
-- ============================================================

CREATE TABLE solicitantes (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Identificación
    nombres         VARCHAR(100) NOT NULL,
    apellido_pat    VARCHAR(80)  NOT NULL,
    apellido_mat    VARCHAR(80),
    fecha_nac       DATE,
    edad            SMALLINT     CHECK (edad BETWEEN 18 AND 80),
    curp            CHAR(18)     UNIQUE,
    rfc             VARCHAR(13),

    -- Contacto
    email           VARCHAR(150) NOT NULL UNIQUE,
    telefono        VARCHAR(15)  NOT NULL,

    -- Domicilio
    calle           VARCHAR(200),
    colonia         VARCHAR(120),
    alcaldia_mpio   VARCHAR(100),
    entidad         VARCHAR(80),
    cp              CHAR(5),
    pais            VARCHAR(60)  NOT NULL DEFAULT 'México',

    -- Auditoría
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_solicitantes_email  ON solicitantes (email);
CREATE INDEX idx_solicitantes_curp   ON solicitantes (curp);

COMMENT ON TABLE solicitantes IS 'Personas físicas que solicitan un préstamo';

-- ============================================================
-- 4. SOLICITUDES  (el corazón del proceso)
-- ============================================================

CREATE TABLE solicitudes (
    id              UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
    folio           VARCHAR(20)       NOT NULL UNIQUE,  -- MNT-000001

    -- Relaciones clave
    solicitante_id  UUID              NOT NULL REFERENCES solicitantes(id),
    empresa_id      INT               NOT NULL REFERENCES empresas(id),
    atendida_por    UUID              REFERENCES usuarios_sistema(id),

    -- Tipo de crédito
    tipo_credito    tipo_credito_enum NOT NULL,

    -- Datos laborales (determinan el score)
    tipo_nomina         tipo_nomina_enum NOT NULL,
    fecha_ingreso_emp   DATE             NOT NULL,
    fecha_baja_estim    DATE,
    
	antiguedad_anos NUMERIC(5,2) GENERATED ALWAYS AS (
    (fecha_baja_estim - fecha_ingreso_emp) / 365.25
) STORED,


    salario_mensual_bruto NUMERIC(12,2)  NOT NULL CHECK (salario_mensual_bruto > 0),
    salario_mensual_neto  NUMERIC(12,2)  NOT NULL CHECK (salario_mensual_neto > 0),

    -- Perfil crediticio declarado
    historial_crediticio  historial_enum NOT NULL,

    -- Datos del crédito solicitado
    monto_solicitado    NUMERIC(12,2)  NOT NULL CHECK (monto_solicitado BETWEEN 3000 AND 80000),
    plazo_meses         SMALLINT       NOT NULL CHECK (plazo_meses IN (3,6,9,12,18,24,30,36)),

    -- Perfil de gastos y deudas
    gastos_personales   NUMERIC(12,2)  NOT NULL DEFAULT 0,
    tiene_deudas        BOOLEAN        NOT NULL DEFAULT FALSE,
    tipo_deuda          VARCHAR(80),
    pago_mensual_deudas NUMERIC(12,2)  NOT NULL DEFAULT 0,

    -- INFONAVIT
    tiene_infonavit     BOOLEAN        NOT NULL DEFAULT FALSE,
    tipo_desc_infonavit VARCHAR(40),
    monto_infonavit     NUMERIC(10,2)  NOT NULL DEFAULT 0,

    -- Estado del proceso
    estado          estado_solicitud_enum NOT NULL DEFAULT 'PENDIENTE',
    fecha_solicitud DATE                  NOT NULL DEFAULT CURRENT_DATE,
    ip_origen       INET,

    -- Auditoría
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_solicitudes_solicitante  ON solicitudes (solicitante_id);
CREATE INDEX idx_solicitudes_empresa      ON solicitudes (empresa_id);
CREATE INDEX idx_solicitudes_estado       ON solicitudes (estado);
CREATE INDEX idx_solicitudes_fecha        ON solicitudes (fecha_solicitud DESC);

COMMENT ON TABLE  solicitudes           IS 'Cada solicitud de préstamo enviada por un solicitante';
COMMENT ON COLUMN solicitudes.antiguedad_anos IS 'Calculado automáticamente: diferencia entre fecha_baja_estim y fecha_ingreso_emp en años';

-- Función y trigger para auto-generar el folio MNT-000001
CREATE SEQUENCE folio_seq START 1;

CREATE OR REPLACE FUNCTION gen_folio()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.folio := 'MNT-' || LPAD(nextval('folio_seq')::TEXT, 6, '0');
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_gen_folio
BEFORE INSERT ON solicitudes
FOR EACH ROW EXECUTE FUNCTION gen_folio();

-- ============================================================
-- 5. EVALUACIONES  (scoring crediticio — Algoritmo.xlsx)
-- ============================================================

CREATE TABLE evaluaciones (
    id              SERIAL       PRIMARY KEY,
    solicitud_id    UUID         NOT NULL UNIQUE REFERENCES solicitudes(id) ON DELETE CASCADE,
    evaluado_por    UUID         REFERENCES usuarios_sistema(id),

    -- Puntajes por criterio (máximos: 50 + 40 + 30 + 30 = 150)
    puntos_ingreso          SMALLINT NOT NULL CHECK (puntos_ingreso      IN (10, 20, 30, 40, 50)),
    puntos_historial        SMALLINT NOT NULL CHECK (puntos_historial    IN (10, 20, 30, 40)),
    puntos_antiguedad       SMALLINT NOT NULL CHECK (puntos_antiguedad   IN (10, 20, 30)),
    puntos_capacidad_pago   SMALLINT NOT NULL CHECK (puntos_capacidad_pago IN (10, 20, 30)),
    puntaje_total           SMALLINT GENERATED ALWAYS AS (
                                puntos_ingreso + puntos_historial +
                                puntos_antiguedad + puntos_capacidad_pago
                            ) STORED,

    -- Cálculos financieros derivados
    isr_retenido            NUMERIC(10,2),
    cuotas_imss             NUMERIC(10,2),
    ingreso_neto_calculado  NUMERIC(12,2),
    flujo_disponible_neto   NUMERIC(12,2),
    capacidad_de_pago       NUMERIC(12,2),  -- flujo_disponible - gastos
    ratio_capacidad_pago    NUMERIC(5,4),   -- pago_credito / salario_neto

    -- Finiquito como garantía
    monto_finiquito_estimado NUMERIC(12,2),
    meses_credito_vs_salario NUMERIC(6,2),
    meses_riesgo_recuperar   NUMERIC(6,2),

    -- Resultado
    ranking             ranking_enum NOT NULL,
    resultado           VARCHAR(12)  NOT NULL CHECK (resultado IN ('APROBADO', 'RECHAZADO')),
    motivo_rechazo      TEXT,
    observaciones       TEXT,
    fecha_evaluacion    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  evaluaciones IS 'Evaluación crediticia basada en el Algoritmo.xlsx: mín 80 pts = aprobado';
COMMENT ON COLUMN evaluaciones.puntaje_total IS 'Suma automática de los 4 criterios. Mínimo aprobatorio: 80 puntos';
COMMENT ON COLUMN evaluaciones.ranking IS 'AAA=110-140 | AA=90-109 | A=80-89 | BB=70-79 | B=60-69 | C-E = rechazo';

-- ============================================================
-- 6. CRÉDITOS  (préstamos aprobados y desembolsados)
-- ============================================================

CREATE TABLE creditos (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    solicitud_id    UUID         NOT NULL UNIQUE REFERENCES solicitudes(id),
    evaluacion_id   INT          NOT NULL REFERENCES evaluaciones(id),

    -- Condiciones aprobadas
    monto_aprobado      NUMERIC(12,2)  NOT NULL,
    plazo_meses         SMALLINT       NOT NULL,
    tasa_nominal_mensual NUMERIC(7,6)  NOT NULL,  -- p.ej. 0.043 = 4.3% mensual
    tasa_nominal_anual   NUMERIC(7,4)  NOT NULL,  -- p.ej. 0.516 = 51.6%
    cat_anual            NUMERIC(7,4)  NOT NULL,  -- p.ej. 0.59856
    iva                  NUMERIC(5,4)  NOT NULL DEFAULT 0.16,

    -- Cargos adicionales
    comision_apertura    NUMERIC(10,2) NOT NULL DEFAULT 0,
    cuota_administracion NUMERIC(10,2) NOT NULL DEFAULT 0,
    seguro_desempleo     NUMERIC(10,2) NOT NULL DEFAULT 0,

    -- Pagos
    pago_mensual_capital_interes NUMERIC(10,2) NOT NULL,
    pago_mensual_total           NUMERIC(10,2) NOT NULL,  -- incluye cuota + seguro

    -- Totales
    total_intereses      NUMERIC(12,2),
    total_iva            NUMERIC(12,2),
    monto_total_pagar    NUMERIC(12,2),

    -- Ciclo de vida
    estado              estado_credito_enum NOT NULL DEFAULT 'ACTIVO',
    fecha_desembolso    DATE,
    fecha_vencimiento   DATE,
    saldo_insoluto      NUMERIC(12,2),
    dias_vencido        INT,
	
    -- Auditoría
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_creditos_estado ON creditos (estado);

COMMENT ON TABLE creditos IS 'Préstamos formalmente aprobados y desembolsados';

-- ============================================================
-- 7. TABLA DE AMORTIZACIÓN  (Simulador_Crédito.xlsx)
-- ============================================================

CREATE TABLE amortizacion (
    id              BIGSERIAL    PRIMARY KEY,
    credito_id      UUID         NOT NULL REFERENCES creditos(id) ON DELETE CASCADE,

    periodo         SMALLINT     NOT NULL CHECK (periodo >= 1),
    mes_calendario  SMALLINT     CHECK (mes_calendario BETWEEN 1 AND 12),
    fecha_pago      DATE,

    -- Desglose del pago
    saldo_inicial       NUMERIC(12,4) NOT NULL,
    capital             NUMERIC(12,4) NOT NULL,
    interes             NUMERIC(12,4) NOT NULL,
    iva                 NUMERIC(12,4) NOT NULL,
    cuota_administracion NUMERIC(10,4) NOT NULL DEFAULT 0,
    seguro              NUMERIC(10,4) NOT NULL DEFAULT 0,
    pago_fijo           NUMERIC(12,4) NOT NULL,  -- capital + interes + iva
    pago_total          NUMERIC(12,4) NOT NULL,  -- pago_fijo + cuota + seguro
    saldo_insoluto      NUMERIC(12,4) NOT NULL,

    -- Estatus de pago
    pagado          BOOLEAN      NOT NULL DEFAULT FALSE,
    fecha_pago_real DATE,
    monto_pagado    NUMERIC(12,2),

    UNIQUE (credito_id, periodo)
);

CREATE INDEX idx_amortizacion_credito ON amortizacion (credito_id);
CREATE INDEX idx_amortizacion_fecha   ON amortizacion (fecha_pago);

COMMENT ON TABLE amortizacion IS 'Tabla de amortización generada por el simulador para cada crédito aprobado';

-- ============================================================
-- 8. DOCUMENTOS
-- ============================================================

CREATE TABLE documentos (
    id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
    solicitud_id    UUID         NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
    tipo            tipo_doc_enum NOT NULL,
    nombre_archivo  VARCHAR(255) NOT NULL,
    url_storage     TEXT         NOT NULL,  -- S3 / GCS / Azure Blob
    tamanio_bytes   INT,
    mime_type       VARCHAR(80),
    verificado      BOOLEAN      NOT NULL DEFAULT FALSE,
    verificado_por  UUID         REFERENCES usuarios_sistema(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_documentos_solicitud ON documentos (solicitud_id);

COMMENT ON TABLE documentos IS 'Archivos adjuntos a una solicitud (INE, comprobantes, etc.)';

-- ============================================================
-- 9. HISTORIAL DE ESTADOS  (trazabilidad completa)
-- ============================================================

CREATE TABLE historial_estados (
    id              BIGSERIAL    PRIMARY KEY,
    solicitud_id    UUID         NOT NULL REFERENCES solicitudes(id) ON DELETE CASCADE,
    estado_anterior estado_solicitud_enum,
    estado_nuevo    estado_solicitud_enum NOT NULL,
    comentario      TEXT,
    usuario_id      UUID         REFERENCES usuarios_sistema(id),
    ip_origen       INET,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_historial_solicitud ON historial_estados (solicitud_id);

COMMENT ON TABLE historial_estados IS 'Registro de cada cambio de estado de una solicitud para auditoría y trazabilidad';

-- Trigger automático para registrar cambios de estado
CREATE OR REPLACE FUNCTION log_cambio_estado()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.estado IS DISTINCT FROM NEW.estado THEN
        INSERT INTO historial_estados (solicitud_id, estado_anterior, estado_nuevo)
        VALUES (NEW.id, OLD.estado, NEW.estado);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_log_estado
AFTER UPDATE ON solicitudes
FOR EACH ROW EXECUTE FUNCTION log_cambio_estado();

-- ============================================================
-- VISTAS ÚTILES
-- ============================================================


CREATE VIEW v_creditos_con_vencido AS
SELECT
    c.*,
    CASE
        WHEN c.estado = 'VENCIDO'
             AND c.fecha_vencimiento < CURRENT_DATE
        THEN CURRENT_DATE - c.fecha_vencimiento
        ELSE 0
    END AS dias_vencido_calc
FROM creditos c;


-- Vista ejecutiva de solicitudes con datos clave
CREATE VIEW v_solicitudes_resumen AS
SELECT
    s.folio,
    s.fecha_solicitud,
    s.estado,
    CONCAT(p.nombres, ' ', p.apellido_pat, ' ', COALESCE(p.apellido_mat,'')) AS nombre_completo,
    p.email,
    p.telefono,
    e.nombre AS empresa,
    s.tipo_credito,
    s.salario_mensual_neto,
    s.monto_solicitado,
    s.plazo_meses,
    s.historial_crediticio,
    s.antiguedad_anos,
    ev.puntaje_total,
    ev.ranking,
    ev.resultado
FROM solicitudes s
JOIN solicitantes p  ON p.id = s.solicitante_id
JOIN empresas e      ON e.id = s.empresa_id
LEFT JOIN evaluaciones ev ON ev.solicitud_id = s.id;

-- Vista de cartera activa
CREATE VIEW v_cartera_activa AS
SELECT
    c.id AS credito_id,
    s.folio,
    CONCAT(p.nombres, ' ', p.apellido_pat) AS acreditado,
    e.nombre AS empresa,
    c.monto_aprobado,
    c.plazo_meses,
    c.tasa_nominal_anual,
    c.cat_anual,
    c.pago_mensual_total,
    c.fecha_desembolso,
    c.fecha_vencimiento,
    c.saldo_insoluto,
    c.estado,
    COUNT(a.id) FILTER (WHERE a.pagado = TRUE)  AS pagos_realizados,
    COUNT(a.id) FILTER (WHERE a.pagado = FALSE) AS pagos_pendientes
FROM creditos c
JOIN solicitudes  s  ON s.id = c.solicitud_id
JOIN solicitantes p  ON p.id = s.solicitante_id
JOIN empresas     e  ON e.id = s.empresa_id
LEFT JOIN amortizacion a ON a.credito_id = c.id
WHERE c.estado = 'ACTIVO'
GROUP BY c.id, s.folio, p.nombres, p.apellido_pat, e.nombre;

-- ============================================================
-- FUNCIÓN: Calcular pago mensual (fórmula del simulador)
-- ============================================================

CREATE OR REPLACE FUNCTION calcular_pago_mensual(
    p_monto     NUMERIC,
    p_plazo     INT,
    p_tasa_mens NUMERIC,  -- tasa mensual sin IVA, p.ej. 0.043
    p_iva       NUMERIC DEFAULT 0.16
) RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE
    tasa_con_iva NUMERIC;
BEGIN
    tasa_con_iva := p_tasa_mens * (1 + p_iva);
    IF tasa_con_iva = 0 THEN
        RETURN ROUND(p_monto / p_plazo, 2);
    END IF;
    RETURN ROUND(
        p_monto * (tasa_con_iva * POWER(1 + tasa_con_iva, p_plazo))
               / (POWER(1 + tasa_con_iva, p_plazo) - 1),
        2
    );
END;
$$;

COMMENT ON FUNCTION calcular_pago_mensual IS
'Calcula pago mensual de amortización francesa. Uso: SELECT calcular_pago_mensual(15000, 12, 0.043);';

-- ============================================================
-- FUNCIÓN: Calcular score crediticio (Algoritmo.xlsx)
-- ============================================================

CREATE OR REPLACE FUNCTION calcular_score(
    p_ingreso_neto      NUMERIC,
    p_historial         historial_enum,
    p_antiguedad_anos   NUMERIC,
    p_ratio_cap_pago    NUMERIC   -- (pago_mensual / salario_neto)
) RETURNS TABLE (
    pts_ingreso       SMALLINT,
    pts_historial     SMALLINT,
    pts_antiguedad    SMALLINT,
    pts_cap_pago      SMALLINT,
    puntaje_total     SMALLINT,
    aprobado          BOOLEAN
) LANGUAGE plpgsql AS $$
DECLARE
    v_ingreso    SMALLINT;
    v_historial  SMALLINT;
    v_antiguedad SMALLINT;
    v_cap_pago   SMALLINT;
    v_total      SMALLINT;
BEGIN
    -- Ingreso (máx 50 pts)
    v_ingreso := CASE
        WHEN p_ingreso_neto > 25427 THEN 50
        WHEN p_ingreso_neto >= 12713 THEN 40
        ELSE 30
    END;

    -- Historial crediticio (máx 40 pts)
    v_historial := CASE p_historial
        WHEN 'EXCELENTE'  THEN 40
        WHEN 'MUY_BUENO'  THEN 30
        WHEN 'BUENO'      THEN 20
        WHEN 'MEDIO_BAJO' THEN 10
    END;

    -- Antigüedad laboral en años (máx 30 pts)
    v_antiguedad := CASE
        WHEN p_antiguedad_anos > 2   THEN 30
        WHEN p_antiguedad_anos >= 1  THEN 20
        ELSE 10
    END;

    -- Capacidad de pago: ratio = pago_mensual / salario_neto (máx 30 pts)
    v_cap_pago := CASE
        WHEN p_ratio_cap_pago < 0.30 THEN 30
        WHEN p_ratio_cap_pago < 0.40 THEN 20
        ELSE 10
    END;

    v_total := v_ingreso + v_historial + v_antiguedad + v_cap_pago;

    RETURN QUERY SELECT
        v_ingreso, v_historial, v_antiguedad, v_cap_pago,
        v_total,
        v_total >= 80;  -- mínimo aprobatorio según Algoritmo.xlsx
END;
$$;

COMMENT ON FUNCTION calcular_score IS
'Aplica el algoritmo de scoring de Algoritmo.xlsx. Puntaje mínimo aprobatorio: 80/140.';

-- ============================================================
-- ÍNDICES ADICIONALES DE RENDIMIENTO
-- ============================================================

CREATE INDEX idx_solicitudes_created  ON solicitudes (created_at DESC);
CREATE INDEX idx_creditos_vencimiento ON creditos (fecha_vencimiento) WHERE estado = 'ACTIVO';
CREATE INDEX idx_amortizacion_vencida ON amortizacion (fecha_pago)
    WHERE pagado = FALSE;

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — ejemplo para agentes
-- ============================================================

ALTER TABLE solicitudes ENABLE ROW LEVEL SECURITY;

CREATE POLICY agente_solo_asignadas ON solicitudes
    FOR ALL TO PUBLIC
    USING (
        atendida_por = current_setting('app.current_user_id', TRUE)::UUID
        OR EXISTS (
            SELECT 1 FROM usuarios_sistema u
            WHERE u.id = current_setting('app.current_user_id', TRUE)::UUID
            AND u.rol = 'ADMIN'
        )
    );

-- ============================================================
-- TRIGGERS DE updated_at
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_upd_empresas       BEFORE UPDATE ON empresas        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_solicitantes   BEFORE UPDATE ON solicitantes     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_solicitudes    BEFORE UPDATE ON solicitudes      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_creditos       BEFORE UPDATE ON creditos         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_upd_usuarios       BEFORE UPDATE ON usuarios_sistema FOR EACH ROW EXECUTE FUNCTION set_updated_at();
