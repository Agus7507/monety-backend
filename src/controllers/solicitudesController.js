const { query: db, pool } = require('../config/db');
const { evaluar, generarAmortizacion } = require('../services/scoringService');
const logger = require('../config/logger');

/* ─────────────────────────────────────────────────────────────
   CREAR SOLICITUD  (POST /api/v1/solicitudes)
   Flujo completo: solicitante → solicitud → evaluación automática
   ───────────────────────────────────────────────────────────── */
async function crear(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      // Personales
      nombres, apellidoPat, apellidoMat, edad, curp, rfc,
      email, telefono,
      // Domicilio
      calle, colonia, alcaldiaMpio, entidad, cp,
      // Laborales
      empresaId, tipoNomina, fechaIngresoEmp, fechaBajaEstim,
      salarioBruto, salarioNeto,
      historialCrediticio,
      // Crédito
      tipoCredito, montoSolicitado, plazoMeses,
      gastos = 0, tieneDeudas = false, tipoDeuda, pagoMensualDeudas = 0,
      tieneInfonavit = false, tipoDescInfonavit, montoInfonavit = 0,
    } = req.body;

    /* 1. Upsert del solicitante (por email) */
    const solRes = await client.query(
      `INSERT INTO solicitantes
         (nombres, apellido_pat, apellido_mat, edad, curp, rfc,
          email, telefono, calle, colonia, alcaldia_mpio, entidad, cp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (email) DO UPDATE SET
         nombres      = EXCLUDED.nombres,
         apellido_pat = EXCLUDED.apellido_pat,
         apellido_mat = EXCLUDED.apellido_mat,
         telefono     = EXCLUDED.telefono,
         updated_at   = NOW()
       RETURNING id`,
      [nombres, apellidoPat, apellidoMat, edad, curp?.toUpperCase(),
       rfc?.toUpperCase(), email, telefono, calle, colonia, alcaldiaMpio, entidad, cp]
    );
    const solicitanteId = solRes.rows[0].id;

    /* 2. Calcular antigüedad */
    const ingreso = new Date(fechaIngresoEmp);
    const baja    = new Date(fechaBajaEstim);
    const antiguedadAnos = (baja - ingreso) / (365.25 * 24 * 3600 * 1000);

    /* 3. Crear la solicitud */
    const solId = await client.query(
      `INSERT INTO solicitudes
         (solicitante_id, empresa_id, tipo_credito, tipo_nomina,
          fecha_ingreso_emp, fecha_baja_estim,
          salario_mensual_bruto, salario_mensual_neto,
          historial_crediticio,
          monto_solicitado, plazo_meses,
          gastos_personales, tiene_deudas, tipo_deuda, pago_mensual_deudas,
          tiene_infonavit, tipo_desc_infonavit, monto_infonavit,
          ip_origen)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id, folio`,
      [solicitanteId, empresaId, tipoCredito, tipoNomina,
       fechaIngresoEmp, fechaBajaEstim,
       salarioBruto, salarioNeto,
       historialCrediticio,
       montoSolicitado, plazoMeses,
       gastos, tieneDeudas, tipoDeuda, pagoMensualDeudas,
       tieneInfonavit, tipoDescInfonavit, montoInfonavit,
       req.ip]
    );
    const { id: solicitudId, folio } = solId.rows[0];

    /* 4. Scoring automático */
    const scoring = evaluar({
      salarioNeto:    parseFloat(salarioNeto),
      historial:      historialCrediticio,
      antiguedadAnos,
      montoSolicitado: parseFloat(montoSolicitado),
      plazoMeses:     parseInt(plazoMeses),
      gastos:         parseFloat(gastos),
      pagoDeudas:     parseFloat(pagoMensualDeudas),
      tipoCredito,
    });

    /* 5. Guardar evaluación */
    await client.query(
      `INSERT INTO evaluaciones
         (solicitud_id, puntos_ingreso, puntos_historial,
          puntos_antiguedad, puntos_capacidad_pago,
          isr_retenido, ingreso_neto_calculado,
          flujo_disponible_neto, capacidad_de_pago,
          ratio_capacidad_pago, monto_finiquito_estimado,
          meses_credito_vs_salario, meses_riesgo_recuperar,
          ranking, resultado, motivo_rechazo)
       VALUES
         ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,0,$10,$11,$12,$13,$14)`,
      [
        solicitudId,
        scoring.puntos.ingreso,
        scoring.puntos.historial,
        scoring.puntos.antiguedad,
        scoring.puntos.capacidadPago,
        salarioNeto,
        scoring.financiero.flujoDisponible,
        scoring.financiero.capacidadPago,
        scoring.financiero.ratio,
        scoring.financiero.mesesCreditoVsSalario,
        scoring.financiero.mesesRiesgo,
        scoring.ranking,
        scoring.aprobado ? 'APROBADO' : 'RECHAZADO',
        scoring.motivoRechazo,
      ]
    );

    /* 6. Actualizar estado de la solicitud según resultado */
    await client.query(
      `UPDATE solicitudes SET estado=$1 WHERE id=$2`,
      [scoring.aprobado ? 'PRE_APROBADA' : 'EN_REVISION', solicitudId]
    );

    await client.query('COMMIT');

    logger.info('Solicitud creada', { folio, aprobado: scoring.aprobado });

    res.status(201).json({
      ok: true,
      folio,
      estado:   scoring.aprobado ? 'PRE_APROBADA' : 'EN_REVISION',
      scoring: {
        aprobado:    scoring.aprobado,
        ranking:     scoring.ranking,
        puntaje:     scoring.puntajeTotal,
        pagoMensual: scoring.financiero.pagoMensual,
        totalPagar:  scoring.financiero.totalPagar,
        motivoRechazo: scoring.motivoRechazo,
      },
      mensaje: scoring.aprobado
        ? '¡Tu solicitud fue pre-aprobada! Un agente te contactará pronto.'
        : 'Tu solicitud está en revisión. Te informaremos en 24 horas.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

/* ─────────────────────────────────────────────────────────────
   CONSULTAR ESTADO  (GET /api/v1/solicitudes/estado/:folio)
   Devuelve datos completos para el panel de detalle del backoffice.
   ───────────────────────────────────────────────────────────── */
async function consultarEstado(req, res, next) {
  try {
    const { folio } = req.params;
    const { rows } = await db(
      `SELECT
         s.id,
         s.folio, s.estado, s.fecha_solicitud,
         s.monto_solicitado, s.plazo_meses, s.tipo_credito,
         s.salario_mensual_neto, s.salario_mensual_bruto,
         s.historial_crediticio,
         s.antiguedad_anos,
         s.gastos_personales, s.tiene_deudas,
         s.pago_mensual_deudas, s.tiene_infonavit,
         -- Solicitante
         p.nombres, p.apellido_pat, p.apellido_mat,
         p.email, p.telefono, p.curp,
         p.entidad, p.alcaldia_mpio,
         CONCAT(p.nombres,' ',p.apellido_pat,' ',COALESCE(p.apellido_mat,'')) AS nombre,
         -- Empresa (LEFT JOIN por si empresa_id no existe aún)
         e.id AS empresa_id_val,
         COALESCE(e.nombre, 'Sin empresa') AS empresa_nombre,
         -- Evaluación
         ev.ranking, ev.puntaje_total, ev.resultado, ev.motivo_rechazo,
         ev.puntos_ingreso, ev.puntos_historial,
         ev.puntos_antiguedad, ev.puntos_capacidad_pago,
         ev.capacidad_de_pago, ev.ratio_capacidad_pago
       FROM solicitudes s
       JOIN solicitantes p        ON p.id = s.solicitante_id
       LEFT JOIN empresas e       ON e.id = s.empresa_id
       LEFT JOIN evaluaciones ev  ON ev.solicitud_id = s.id
       WHERE s.folio = $1`,
      [folio.toUpperCase()]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'Folio no encontrado' });
    }

    res.json({ ok: true, solicitud: rows[0] });
  } catch (err) { next(err); }
}

/* ─────────────────────────────────────────────────────────────
   LISTAR  (GET /api/v1/solicitudes)  — uso interno
   ───────────────────────────────────────────────────────────── */
async function listar(req, res, next) {
  try {
    const page    = Math.max(1, parseInt(req.query.page  || '1'));
    const limit   = Math.min(100, parseInt(req.query.limit || '20'));
    const offset  = (page - 1) * limit;
    const estado  = req.query.estado;
    const empresa = req.query.empresa;

    const conditions = [];
    const params     = [];

    if (estado) {
      params.push(estado);
      conditions.push(`s.estado = $${params.length}`);
    }
    if (empresa) {
      params.push(`%${empresa}%`);
      conditions.push(`e.nombre ILIKE $${params.length}`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    params.push(limit, offset);
    const { rows } = await db(
      `SELECT
         s.id, s.folio, s.estado, s.fecha_solicitud, s.tipo_credito,
         s.monto_solicitado, s.plazo_meses,
         s.salario_mensual_neto, s.historial_crediticio, s.antiguedad_anos,
         CONCAT(p.nombres,' ',p.apellido_pat) AS nombre,
         p.email, p.telefono,
         COALESCE(e.nombre, 'Sin empresa') AS empresa,
         ev.ranking, ev.puntaje_total, ev.resultado
       FROM solicitudes s
       JOIN solicitantes p         ON p.id = s.solicitante_id
       LEFT JOIN empresas e        ON e.id = s.empresa_id
       LEFT JOIN evaluaciones ev   ON ev.solicitud_id = s.id
       ${where}
       ORDER BY s.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    // Conteo total
    const countParams = params.slice(0, -2);
    const { rows: cnt } = await db(
      `SELECT COUNT(*) FROM solicitudes s
       LEFT JOIN empresas e ON e.id = s.empresa_id ${where}`,
      countParams
    );

    res.json({
      ok:    true,
      data:  rows,
      meta:  { total: parseInt(cnt[0].count), page, limit, pages: Math.ceil(cnt[0].count / limit) },
    });
  } catch (err) { next(err); }
}

/* ─────────────────────────────────────────────────────────────
   OBTENER DETALLE  (GET /api/v1/solicitudes/:id)
   ───────────────────────────────────────────────────────────── */
async function obtener(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db(
      `SELECT
         s.id, s.folio, s.estado, s.fecha_solicitud,
         s.tipo_credito, s.tipo_nomina,
         s.monto_solicitado, s.plazo_meses,
         s.salario_mensual_bruto, s.salario_mensual_neto,
         s.historial_crediticio, s.antiguedad_anos,
         s.gastos_personales, s.tiene_deudas,
         s.pago_mensual_deudas, s.tiene_infonavit,
         -- Solicitante
         p.nombres, p.apellido_pat, p.apellido_mat,
         p.email, p.telefono, p.curp, p.rfc,
         p.calle, p.colonia, p.alcaldia_mpio, p.entidad, p.cp,
         TRIM(CONCAT(p.nombres,' ',p.apellido_pat,' ',COALESCE(p.apellido_mat,''))) AS nombre,
         -- Empresa
         COALESCE(e.nombre,'Sin empresa') AS empresa_nombre,
         -- Evaluación
         ev.ranking, ev.puntaje_total, ev.resultado, ev.motivo_rechazo,
         ev.puntos_ingreso, ev.puntos_historial,
         ev.puntos_antiguedad, ev.puntos_capacidad_pago,
         ev.capacidad_de_pago, ev.ratio_capacidad_pago,
         ev.meses_credito_vs_salario,
         -- Crédito formalizado
         c.id AS credito_id, c.monto_aprobado,
         c.tasa_nominal_anual, c.cat_anual,
         c.pago_mensual_total, c.fecha_desembolso,
         c.fecha_vencimiento, c.saldo_insoluto, c.estado AS estado_credito
       FROM solicitudes s
       JOIN solicitantes p        ON p.id = s.solicitante_id
       LEFT JOIN empresas e       ON e.id = s.empresa_id
       LEFT JOIN evaluaciones ev  ON ev.solicitud_id = s.id
       LEFT JOIN creditos c       ON c.solicitud_id  = s.id
       WHERE s.id = $1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
    }

    // Historial de estados
    const { rows: historial } = await db(
      `SELECT estado_anterior, estado_nuevo, comentario, created_at
       FROM historial_estados WHERE solicitud_id=$1 ORDER BY created_at ASC`,
      [id]
    );

    // Documentos adjuntos
    const { rows: docs } = await db(
      `SELECT tipo, nombre_archivo, verificado, created_at
       FROM documentos WHERE solicitud_id=$1`,
      [id]
    );

    res.json({ ok: true, solicitud: rows[0], historial, documentos: docs });
  } catch (err) { next(err); }
}

/* ─────────────────────────────────────────────────────────────
   CAMBIAR ESTADO  (PATCH /api/v1/solicitudes/:id/estado)
   ───────────────────────────────────────────────────────────── */
async function cambiarEstado(req, res, next) {
  try {
    const { id } = req.params;
    const { estado, comentario } = req.body;

    const { rows } = await db(
      `UPDATE solicitudes SET estado=$1, atendida_por=$2, updated_at=NOW()
       WHERE id=$3 RETURNING folio, estado`,
      [estado, req.user.id, id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
    }

    // Registrar en historial manualmente (además del trigger)
    if (comentario) {
      await db(
        `INSERT INTO historial_estados (solicitud_id, estado_nuevo, comentario, usuario_id)
         VALUES ($1,$2,$3,$4)`,
        [id, estado, comentario, req.user.id]
      );
    }

    logger.info('Estado cambiado', { id, estado, agente: req.user.email });
    res.json({ ok: true, folio: rows[0].folio, estado: rows[0].estado });
  } catch (err) { next(err); }
}

/* ─────────────────────────────────────────────────────────────
   EVALUAR / RE-EVALUAR  (POST /api/v1/solicitudes/:id/evaluar)
   ───────────────────────────────────────────────────────────── */
async function evaluarSolicitud(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;

    const { rows } = await client.query(
      `SELECT s.*, p.email
       FROM solicitudes s
       JOIN solicitantes p ON p.id = s.solicitante_id
       WHERE s.id=$1`, [id]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
    }
    const sol = rows[0];

    const antiguedadAnos =
      (new Date(sol.fecha_baja_estim) - new Date(sol.fecha_ingreso_emp)) /
      (365.25 * 24 * 3600 * 1000);

    const scoring = evaluar({
      salarioNeto:     parseFloat(sol.salario_mensual_neto),
      historial:       sol.historial_crediticio,
      antiguedadAnos,
      montoSolicitado: parseFloat(sol.monto_solicitado),
      plazoMeses:      sol.plazo_meses,
      gastos:          parseFloat(sol.gastos_personales || 0),
      pagoDeudas:      parseFloat(sol.pago_mensual_deudas || 0),
      tipoCredito:     sol.tipo_credito,
    });

    // Upsert evaluación
    await client.query(
      `INSERT INTO evaluaciones
         (solicitud_id, evaluado_por, puntos_ingreso, puntos_historial,
          puntos_antiguedad, puntos_capacidad_pago,
          flujo_disponible_neto, capacidad_de_pago, ratio_capacidad_pago,
          meses_credito_vs_salario, meses_riesgo_recuperar,
          ranking, resultado, motivo_rechazo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (solicitud_id) DO UPDATE SET
         evaluado_por=$2, puntos_ingreso=$3, puntos_historial=$4,
         puntos_antiguedad=$5, puntos_capacidad_pago=$6,
         flujo_disponible_neto=$7, capacidad_de_pago=$8,
         ratio_capacidad_pago=$9, meses_credito_vs_salario=$10,
         meses_riesgo_recuperar=$11, ranking=$12,
         resultado=$13, motivo_rechazo=$14,
         fecha_evaluacion=NOW()`,
      [id, req.user.id,
       scoring.puntos.ingreso, scoring.puntos.historial,
       scoring.puntos.antiguedad, scoring.puntos.capacidadPago,
       scoring.financiero.flujoDisponible, scoring.financiero.capacidadPago,
       scoring.financiero.ratio,
       scoring.financiero.mesesCreditoVsSalario, scoring.financiero.mesesRiesgo,
       scoring.ranking,
       scoring.aprobado ? 'APROBADO' : 'RECHAZADO',
       scoring.motivoRechazo]
    );

    await client.query('COMMIT');
    res.json({ ok: true, scoring });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = { crear, consultarEstado, listar, obtener, cambiarEstado, evaluar: evaluarSolicitud };
