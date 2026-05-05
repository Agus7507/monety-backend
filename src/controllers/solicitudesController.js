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
      // Percepciones extra (del cuestionario)
      tienePercepVariables = false,
      percepcionesVariables = 0,
      // Crédito
      tipoCredito, montoSolicitado, plazoMeses,
      gastos = 0, tieneDeudas = false, tipoDeuda, pagoMensualDeudas = 0,
      tieneInfonavit = false, tipoDescInfonavit, montoInfonavit = 0,
    } = req.body;

    /* Ingreso neto efectivo = salario neto + percepciones variables (si aplica) */
    const ingresoNetoEfectivo = parseFloat(salarioNeto) +
      (tienePercepVariables ? parseFloat(percepcionesVariables || 0) : 0);

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

    /* 4. Scoring automático — usa el ingreso efectivo (salario + percepciones) */
    const scoring = evaluar({
      salarioNeto:    ingresoNetoEfectivo,
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
        ingresoNetoEfectivo,   // ingreso_neto_calculado (salario + percepciones)
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
   Si el nuevo estado es APROBADA → formaliza el crédito automáticamente.
   ───────────────────────────────────────────────────────────── */
async function cambiarEstado(req, res, next) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const {
      estado, comentario,
      // Parámetros opcionales para personalizar el crédito al aprobar:
      monto_aprobado, plazo_meses, tasa_nominal_mensual,
      comision_apertura = 0, cuota_administracion = 0, seguro_desempleo = 0,
      fecha_desembolso,
    } = req.body;

    // 1. Actualizar estado de la solicitud
    const { rows } = await client.query(
      `UPDATE solicitudes SET estado=$1, atendida_por=$2, updated_at=NOW()
       WHERE id=$3 RETURNING folio, estado, monto_solicitado, plazo_meses,
             tipo_credito, tipo_nomina`,
      [estado, req.user.id, id]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
    }

    const sol = rows[0];

    // 2. Registrar en historial
    await client.query(
      `INSERT INTO historial_estados (solicitud_id, estado_nuevo, comentario, usuario_id)
       VALUES ($1,$2,$3,$4)`,
      [id, estado, comentario || null, req.user.id]
    );

    let creditoId = null;

    // 3. Si se aprueba → crear crédito automáticamente
    if (estado === 'APROBADA') {

      // Verificar que no exista ya un crédito para esta solicitud
      const { rows: existing } = await client.query(
        'SELECT id FROM creditos WHERE solicitud_id=$1', [id]
      );

      if (!existing.length) {
        // Buscar evaluación existente (cualquier resultado) o crearla si no existe
        let evalId;
        const { rows: evalRows } = await client.query(
          'SELECT id, resultado, puntaje_total FROM evaluaciones WHERE solicitud_id=$1 ORDER BY fecha_evaluacion DESC LIMIT 1',
          [id]
        );

        if (evalRows.length) {
          evalId = evalRows[0].id;
          // Si la evaluación estaba rechazada, actualizarla a APROBADO (decisión manual del analista)
          if (evalRows[0].resultado !== 'APROBADO') {
            await client.query(
              `UPDATE evaluaciones SET resultado='APROBADO', motivo_rechazo=NULL,
               fecha_evaluacion=NOW() WHERE id=$1`,
              [evalId]
            );
          }
        } else {
          // No hay evaluación — crear una automáticamente con los datos de la solicitud
          const { rows: solData } = await client.query(
            `SELECT s.salario_mensual_neto, s.historial_crediticio, s.gastos_personales,
                    s.pago_mensual_deudas, s.monto_solicitado, s.plazo_meses,
                    s.tipo_credito, s.tipo_nomina,
                    EXTRACT(EPOCH FROM (s.fecha_baja_estim - s.fecha_ingreso_emp))/31536000 AS antiguedad
             FROM solicitudes s WHERE s.id=$1`, [id]
          );
          if (!solData.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
          }
          const sd = solData[0];
          const { evaluar } = require('../services/scoringService');
          const sc = evaluar({
            salarioNeto:     parseFloat(sd.salario_mensual_neto),
            historial:       sd.historial_crediticio,
            antiguedadAnos:  parseFloat(sd.antiguedad || 0),
            montoSolicitado: parseFloat(sd.monto_solicitado),
            plazoMeses:      parseInt(sd.plazo_meses),
            gastos:          parseFloat(sd.gastos_personales || 0),
            pagoDeudas:      parseFloat(sd.pago_mensual_deudas || 0),
            tipoCredito:     sd.tipo_credito,
          });
          const { rows: newEval } = await client.query(
            `INSERT INTO evaluaciones
               (solicitud_id, evaluado_por, puntos_ingreso, puntos_historial,
                puntos_antiguedad, puntos_capacidad_pago,
                flujo_disponible_neto, capacidad_de_pago, ratio_capacidad_pago,
                meses_credito_vs_salario, meses_riesgo_recuperar,
                ranking, resultado, motivo_rechazo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'APROBADO',NULL)
             RETURNING id`,
            [id, req.user.id,
             sc.puntos.ingreso, sc.puntos.historial, sc.puntos.antiguedad, sc.puntos.capacidadPago,
             sc.financiero.flujoDisponible, sc.financiero.capacidadPago, sc.financiero.ratio,
             sc.financiero.mesesCreditoVsSalario, sc.financiero.mesesRiesgo,
             sc.ranking]
          );
          evalId = newEval[0].id;
        }

        // Calcular condiciones (usar los del cuerpo del request si el analista las personalizó)
        const montoFinal  = parseFloat(monto_aprobado  || sol.monto_solicitado);
        const plazoFinal  = parseInt(plazo_meses       || sol.plazo_meses);
        const tasaFinal   = parseFloat(tasa_nominal_mensual
          || (sol.tipo_credito === 'NOMINA' ? 0.043 : 0.05));

        const iva        = 0.16;
        const tasaConIva = tasaFinal * (1 + iva);
        const tasaAnual  = tasaFinal * 12;
        const cat        = sol.tipo_credito === 'NOMINA' ? 0.59856 : 0.72;

        // Fórmula de amortización francesa
        const pagoMensual = montoFinal *
          (tasaConIva * Math.pow(1 + tasaConIva, plazoFinal)) /
          (Math.pow(1 + tasaConIva, plazoFinal) - 1);

        const pagoTotal      = pagoMensual + parseFloat(cuota_administracion) + parseFloat(seguro_desempleo);
        const totalIntereses = (pagoMensual * plazoFinal) - montoFinal;
        const totalIva       = totalIntereses * iva;
        const totalPagar     = montoFinal + totalIntereses + totalIva;

        const desembolso  = fecha_desembolso ? new Date(fecha_desembolso) : new Date();
        const vencimiento = new Date(desembolso);
        vencimiento.setMonth(vencimiento.getMonth() + plazoFinal);

        // Insertar crédito
        const { rows: cRows } = await client.query(
          `INSERT INTO creditos
             (solicitud_id, evaluacion_id,
              monto_aprobado, plazo_meses,
              tasa_nominal_mensual, tasa_nominal_anual, cat_anual, iva,
              comision_apertura, cuota_administracion, seguro_desempleo,
              pago_mensual_capital_interes, pago_mensual_total,
              total_intereses, total_iva, monto_total_pagar,
              saldo_insoluto, fecha_desembolso, fecha_vencimiento)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           RETURNING id`,
          [id, evalId,
           montoFinal, plazoFinal,
           tasaFinal, tasaAnual, cat, iva,
           comision_apertura, cuota_administracion, seguro_desempleo,
           Math.round(pagoMensual * 100) / 100,
           Math.round(pagoTotal   * 100) / 100,
           Math.round(totalIntereses * 100) / 100,
           Math.round(totalIva       * 100) / 100,
           Math.round(totalPagar     * 100) / 100,
           montoFinal,
           desembolso.toISOString().slice(0, 10),
           vencimiento.toISOString().slice(0, 10)]
        );
        creditoId = cRows[0].id;

        // Generar tabla de amortización completa
        const { generarAmortizacion } = require('../services/scoringService');
        const tabla = generarAmortizacion({
          monto:       montoFinal,
          plazo:       plazoFinal,
          tipoCredito: sol.tipo_credito,
          fechaInicio: desembolso.toISOString().slice(0, 10),
        });

        for (const row of tabla) {
          await client.query(
            `INSERT INTO amortizacion
               (credito_id, periodo, fecha_pago, saldo_inicial,
                capital, interes, iva, cuota_administracion, seguro,
                pago_fijo, pago_total, saldo_insoluto)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [creditoId, row.periodo, row.fechaPago, row.saldoInicial,
             row.capital, row.interes, row.iva,
             cuota_administracion, seguro_desempleo,
             row.pagoFijo, row.pagoTotal, row.saldoInsoluto]
          );
        }

        logger.info('Crédito auto-formalizado al aprobar', { creditoId, solicitudId: id, monto: montoFinal });
      }
    }

    await client.query('COMMIT');
    logger.info('Estado cambiado', { id, estado, agente: req.user.email });

    res.json({
      ok: true,
      folio:     sol.folio,
      estado:    sol.estado,
      creditoId: creditoId || undefined,
      mensaje:   estado === 'APROBADA' && creditoId
        ? 'Solicitud aprobada y crédito formalizado automáticamente'
        : undefined,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
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
