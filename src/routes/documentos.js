/**
 * documentos.js
 * Genera la Carta de Aprobación y el Contrato de Mutuo con datos reales de la BD.
 * Las rutas devuelven HTML optimizado para impresión / window.print() → PDF.
 */

const router     = require('express').Router();
const { param }  = require('express-validator');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { authMiddleware }         = require('../middleware/auth');
const { query: db }              = require('../config/db');

// ── Datos legales del MUTUANTE (configurables por env) ─────────────────────
const MUTUANTE = {
  nombre:    process.env.MUTUANTE_NOMBRE   || 'AGENDA CON PUBLICIDAD, S.A. DE C.V.',
  rfc:       process.env.MUTUANTE_RFC      || 'APU210304LX9',
  domicilio: process.env.MUTUANTE_DOM      || 'Av. Río Mixcoac No. 25 Piso 2 Int. 1C, Col. Crédito Constructor, Benito Juárez, CDMX, C.P. 03940',
  rep:       process.env.MUTUANTE_REP      || 'MA EUGENIA DE LA CRUZ RAMOS',
  cargo:     process.env.MUTUANTE_CARGO    || 'Apoderada Legal',
  notario:   'Instrumento Público Núm. 133,104 ante el Lic. José Ángel Fernández Uría, Notario Público Núm. 217 de la CDMX, de fecha 04 de marzo de 2021.',
  notario2:  'Instrumento Público Núm. 147,223 ante el Lic. José Ángel Fernández Uría, Notario Público Núm. 217 de la CDMX, de fecha 31 de marzo de 2023.',
};

const CONTACTO = {
  nombre:   process.env.CONTACTO_NOMBRE || 'Lic. Dulce Maria Aguilar',
  cargo:    process.env.CONTACTO_CARGO  || 'Dirección Comercial y Atracción de Talento',
  web:      'www.monety.mx',
  ig:       '@monety.finanzas',
  li:       'Monety',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Convierte número a texto en pesos */
function mxnText(n) {
  const num  = parseFloat(n) || 0;
  const int  = Math.floor(num);
  const cent = Math.round((num - int) * 100);
  return `$${num.toLocaleString('es-MX', { minimumFractionDigits: 2 })} (${numberToWords(int).toUpperCase()} PESOS ${cent.toString().padStart(2,'0')}/100 M.N.)`;
}

function numberToWords(n) {
  if (n === 0) return 'cero';
  const unidades = ['','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve',
    'diez','once','doce','trece','catorce','quince','dieciséis','diecisiete','dieciocho','diecinueve'];
  const decenas  = ['','diez','veinte','treinta','cuarenta','cincuenta','sesenta','setenta','ochenta','noventa'];
  const centenas = ['','ciento','doscientos','trescientos','cuatrocientos','quinientos',
    'seiscientos','setecientos','ochocientos','novecientos'];
  if (n < 20) return unidades[n];
  if (n < 100) {
    const r = n % 10;
    return r ? `${decenas[Math.floor(n/10)]} y ${unidades[r]}` : decenas[Math.floor(n/10)];
  }
  if (n === 100) return 'cien';
  if (n < 1000) {
    const r = n % 100;
    return r ? `${centenas[Math.floor(n/100)]} ${numberToWords(r)}` : centenas[Math.floor(n/100)];
  }
  if (n < 2000) return `mil ${numberToWords(n % 1000)}`.trim();
  if (n < 1000000) {
    const miles = Math.floor(n / 1000);
    const r = n % 1000;
    return (r ? `${numberToWords(miles)} mil ${numberToWords(r)}` : `${numberToWords(miles)} mil`).trim();
  }
  return n.toLocaleString('es-MX');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Calcula pago quincenal con amortización francesa */
function calcPagoQuincenal(monto, tasaMensual, plazoMeses) {
  const n    = plazoMeses * 2;               // quincenas totales
  const r    = Math.pow(1 + tasaMensual, 0.5) - 1; // tasa quincenal equivalente
  const pago = monto * (r * Math.pow(1+r, n)) / (Math.pow(1+r, n) - 1);
  return pago;
}

/** Genera tabla de amortización quincenal */
function tablaAmortQuincenal(monto, tasaMensual, plazoMeses) {
  const n    = plazoMeses * 2;
  const r    = Math.pow(1 + tasaMensual, 0.5) - 1;
  const pago = monto * (r * Math.pow(1+r, n)) / (Math.pow(1+r, n) - 1);
  let saldo  = monto;
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const int = saldo * r;
    const cap = pago - int;
    saldo    -= cap;
    rows.push({ num: i, capital: cap, interes: int, pago, saldo: Math.max(0, saldo) });
  }
  return { pago, rows, total: pago * n };
}

/** CSS compartido para ambos documentos */
const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Montserrat', Arial, sans-serif; font-size: 11pt; color: #222; background: white; }

  @page { size: letter; margin: 15mm 18mm 20mm; }
  @media print {
    .no-print { display: none !important; }
    body { margin: 0; }
    .page-break { page-break-after: always; }
  }

  .doc-wrap { max-width: 800px; margin: 0 auto; padding: 24px 32px; background: white; }

  /* ── Header ── */
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 28px; padding-bottom: 10px; }
  .logo-box { display: flex; align-items: center; gap: 10px; }
  .logo-m { width: 44px; height: 44px; background: #1BA896; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: white; font-size: 22px; font-weight: 800; }
  .logo-text { font-size: 22px; font-weight: 800; color: #1BA896; }
  .logo-sub { font-size: 8pt; color: #888; margin-top: 2px; }
  .header-deco { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .deco-pill { height: 10px; border-radius: 5px; background: linear-gradient(to right, #1BA896, #0d6e62); }

  /* ── Carta ── */
  .carta-body { line-height: 1.75; }
  .carta-fecha { color: #555; margin-bottom: 18px; }
  .carta-dest { font-weight: 700; font-size: 13pt; color: #111; margin-bottom: 18px; }
  .carta-dest span { color: #1BA896; }
  .carta-p { margin-bottom: 14px; text-align: justify; }
  .carta-bold { font-weight: 700; }
  .carta-list { margin: 14px 0 14px 18px; }
  .carta-list li { margin-bottom: 8px; }
  .carta-list li strong { color: #111; }
  .firma-box { margin-top: 48px; }
  .firma-line { width: 280px; border-top: 1.5px solid #333; margin-bottom: 6px; }
  .firma-label { font-size: 10pt; color: #444; }

  /* ── Footer ── */
  .doc-footer { margin-top: 40px; padding-top: 14px; border-top: 2px solid #1BA896; display: flex; justify-content: center; gap: 40px; color: #555; font-size: 9pt; }
  .doc-footer span { display: flex; align-items: center; gap: 5px; }

  /* ── Contrato ── */
  .contrato-title { text-align: center; font-size: 11pt; font-weight: 700; text-transform: uppercase; line-height: 1.5; margin-bottom: 24px; color: #111; }
  .contrato-section { font-weight: 700; text-transform: uppercase; text-align: center; margin: 20px 0 12px; font-size: 11pt; letter-spacing: 2px; color: #1BA896; }
  .contrato-p { margin-bottom: 12px; text-align: justify; line-height: 1.7; }
  .clausula { margin-bottom: 14px; text-align: justify; line-height: 1.7; }
  .clausula-title { font-weight: 700; text-transform: uppercase; }
  .firmas-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 60px; }
  .firma-block { text-align: center; }
  .firma-block .firma-line { margin: 0 auto 8px; width: 220px; }
  .firma-party { font-weight: 700; font-size: 10pt; margin-bottom: 4px; }
  .firma-name { font-size: 10pt; color: #444; }

  /* ── Print button ── */
  .print-bar { background: #1BA896; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
  .print-bar h3 { color: white; font-size: 14pt; }
  .btn-print { background: white; color: #1BA896; border: none; padding: 10px 28px; border-radius: 8px; font-weight: 700; font-size: 13pt; cursor: pointer; }
  .btn-print:hover { background: #e8f7f5; }
`;

// ── Obtener datos completos de solicitud ────────────────────────────────────
async function getDatosSolicitud(id) {
  const { rows } = await db(
    `SELECT
       s.id, s.folio, s.estado, s.fecha_solicitud,
       s.monto_solicitado, s.plazo_meses, s.tipo_credito, s.tipo_nomina,
       s.salario_mensual_neto, s.salario_mensual_bruto,
       s.historial_crediticio, s.antiguedad_anos,
       -- Solicitante
       p.nombres, p.apellido_pat, p.apellido_mat, p.curp,
       p.email, p.telefono,
       TRIM(CONCAT(p.nombres,' ',p.apellido_pat,' ',COALESCE(p.apellido_mat,''))) AS nombre_completo,
       -- Empresa
       COALESCE(e.nombre,'Sin empresa') AS empresa_nombre,
       -- Evaluación
       ev.ranking, ev.puntaje_total, ev.resultado,
       ev.puntos_ingreso, ev.puntos_historial,
       ev.puntos_antiguedad, ev.puntos_capacidad_pago,
       -- Crédito formalizado (si existe)
       c.monto_aprobado, c.tasa_nominal_mensual, c.pago_mensual_total,
       c.fecha_desembolso, c.fecha_vencimiento, c.cat_anual
     FROM solicitudes s
     JOIN solicitantes p        ON p.id = s.solicitante_id
     LEFT JOIN empresas e       ON e.id = s.empresa_id
     LEFT JOIN evaluaciones ev  ON ev.solicitud_id = s.id
     LEFT JOIN creditos c       ON c.solicitud_id  = s.id
     WHERE s.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/documentos/:id/carta   — Carta de Aprobación
// ═══════════════════════════════════════════════════════════════
router.get('/:id/carta',
  authMiddleware,
  param('id').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const sol = await getDatosSolicitud(req.params.id);
      if (!sol) return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
      if (!['PRE_APROBADA', 'APROBADA'].includes(sol.estado)) {
        return res.status(400).json({ ok: false, message: 'La solicitud debe estar aprobada para generar la carta' });
      }

      // Datos financieros
      const monto      = parseFloat(sol.monto_aprobado || sol.monto_solicitado);
      const plazo      = parseInt(sol.plazo_meses);
      const tasaMens   = parseFloat(sol.tasa_nominal_mensual || 0.043);
      const esQuinc    = sol.tipo_nomina === 'QUINCENAL';
      const esSemanal  = sol.tipo_nomina === 'SEMANAL';

      let pagoLabel = '', pagosLabel = '', totalPagar = 0;

      if (esQuinc) {
        const { pago, rows, total } = tablaAmortQuincenal(monto, tasaMens, plazo);
        const n = rows.length;
        const ultimo = rows[n-1].pago;
        const normal = rows.slice(0, n-1).every(r => Math.abs(r.pago - pago) < 1);
        totalPagar = total;
        pagoLabel  = `${n} de $${pago.toFixed(2)} MXN IVA incluido`;
        pagosLabel = 'Descuento quincenal';
      } else {
        // Mensual
        const r    = tasaMens * 1.16; // con IVA
        const n    = plazo;
        const pago = monto * (r * Math.pow(1+r, n)) / (Math.pow(1+r, n) - 1);
        totalPagar = pago * n;
        pagoLabel  = `${n} de $${pago.toFixed(2)} MXN IVA incluido`;
        pagosLabel = 'Pago mensual';
      }

      const fechaDoc = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Carta de Aprobación — ${sol.folio}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="print-bar no-print">
  <h3>Carta de Aprobación · ${sol.folio}</h3>
  <button class="btn-print" onclick="window.print()">⬇ Imprimir / Guardar PDF</button>
</div>
<div class="doc-wrap">
  <!-- HEADER -->
  <div class="header">
    <div class="logo-box">
      <div class="logo-m">M</div>
      <div>
        <div class="logo-text">Monety</div>
        <div class="logo-sub">Soluciones financieras que te respaldan</div>
      </div>
    </div>
    <div class="header-deco">
      <div class="deco-pill" style="width:120px;opacity:.6"></div>
      <div class="deco-pill" style="width:80px;opacity:.4;margin-top:4px"></div>
      <div class="deco-pill" style="width:50px;opacity:.25;margin-top:4px"></div>
    </div>
  </div>

  <!-- CUERPO -->
  <div class="carta-body">
    <p class="carta-fecha">${fechaDoc}<br>Ciudad de México</p>

    <p class="carta-dest">Estimado(a): <span>${sol.nombre_completo}</span></p>

    <p class="carta-p">¡Felicitaciones! Nos complace informarte que tu solicitud de préstamo ha sido <strong class="carta-bold">aprobada</strong>. Agradecemos la confianza que has depositado en Monety y nos entusiasma acompañarte en este nuevo paso hacia tus metas financieras.</p>

    <p class="carta-p">A continuación, encontrarás los detalles de tu préstamo:</p>

    <ul class="carta-list">
      <li><strong>Monto aprobado:</strong> $${monto.toLocaleString('es-MX', { minimumFractionDigits: 2 })} MXN</li>
      <li><strong>Plazo del préstamo:</strong> ${plazo} meses</li>
      <li><strong>${pagosLabel}:</strong> ${pagoLabel}</li>
      <li><strong>Tasa de interés:</strong> ${(tasaMens * 100).toFixed(1)}% mensual</li>
      <li><strong>Mecanismo de dispersión:</strong> Transferencia SPEI.</li>
    </ul>

    <p class="carta-p">Nuestro compromiso es que tu experiencia sea sencilla, transparente y cómoda. Para cualquier duda, aclaración o soporte relacionado con tu préstamo, te pedimos dirigirte al canal de atención bajo la <strong class="carta-bold">${CONTACTO.cargo} (${CONTACTO.nombre})</strong>. Ella estará encantada de brindarte toda la información y acompañamiento que necesites.</p>

    <p class="carta-p">En Monety creemos que cada paso financiero es una oportunidad para crecer. Estamos seguros de que este préstamo será un apoyo efectivo para cumplir tus objetivos, y nuestro equipo estará siempre disponible para acompañarte en el camino.</p>

    <p class="carta-p">Gracias por elegirnos y nuevamente, ¡felicidades por esta aprobación!</p>

    <p class="carta-p">Con aprecio,<br><strong>Monety.</strong></p>

    <div class="firma-box">
      <div class="firma-line"></div>
      <div class="firma-label">Acepto</div>
    </div>
  </div>

  <!-- FOOTER -->
  <div class="doc-footer">
    <span>📸 ${CONTACTO.ig}</span>
    <span>🌐 ${CONTACTO.web}</span>
    <span>💼 ${CONTACTO.li}</span>
  </div>
</div>
<script>
  // Auto-print en modo producción si viene con ?print=1
  if (new URLSearchParams(window.location.search).get('print') === '1') {
    window.onload = () => setTimeout(() => window.print(), 600);
  }
</script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/documentos/:id/contrato  — Contrato de Mutuo
// ═══════════════════════════════════════════════════════════════
router.get('/:id/contrato',
  authMiddleware,
  param('id').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const sol = await getDatosSolicitud(req.params.id);
      if (!sol) return res.status(404).json({ ok: false, message: 'Solicitud no encontrada' });
      if (!['PRE_APROBADA', 'APROBADA'].includes(sol.estado)) {
        return res.status(400).json({ ok: false, message: 'La solicitud debe estar aprobada para generar el contrato' });
      }

      const monto    = parseFloat(sol.monto_aprobado || sol.monto_solicitado);
      const plazo    = parseInt(sol.plazo_meses);
      const tasaMens = parseFloat(sol.tasa_nominal_mensual || 0.043);
      const esQuinc  = sol.tipo_nomina === 'QUINCENAL';

      // Pago y total
      let pagoQuin = 0, totalContrato = 0, formaPago = '', numPagos = plazo;
      if (esQuinc) {
        const { pago, rows } = tablaAmortQuincenal(monto, tasaMens, plazo);
        pagoQuin      = pago;
        totalContrato = pago * rows.length;
        numPagos      = rows.length;
        formaPago     = `$${pago.toFixed(2)} (${numberToWords(Math.round(pago)).toUpperCase()} PESOS ${Math.round((pago - Math.floor(pago))*100).toString().padStart(2,'0')}/100 M.N.) de manera quincenal.`;
      } else {
        const r    = tasaMens * 1.16;
        const pago = monto * (r * Math.pow(1+r, plazo)) / (Math.pow(1+r, plazo) - 1);
        pagoQuin      = pago;
        totalContrato = pago * plazo;
        formaPago     = `$${pago.toFixed(2)} (${numberToWords(Math.round(pago)).toUpperCase()} PESOS ${Math.round((pago - Math.floor(pago))*100).toString().padStart(2,'0')}/100 M.N.) de manera mensual.`;
      }

      const fechaDoc  = new Date().toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' });
      const fechaFin  = sol.fecha_vencimiento
        ? new Date(sol.fecha_vencimiento).toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' })
        : (() => { const d = new Date(); d.setMonth(d.getMonth() + plazo); return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'long', year: 'numeric' }); })();

      const montoTxt = mxnText(monto);
      const totalTxt = mxnText(totalContrato);
      const nombre   = sol.nombre_completo.toUpperCase();
      const curp     = sol.curp || '(CURP pendiente de registrar)';

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Contrato de Mutuo — ${sol.folio}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="print-bar no-print">
  <h3>Contrato de Mutuo · ${sol.folio} · ${sol.nombre_completo}</h3>
  <button class="btn-print" onclick="window.print()">⬇ Imprimir / Guardar PDF</button>
</div>
<div class="doc-wrap">

  <!-- HEADER -->
  <div class="header">
    <div class="logo-box">
      <div class="logo-m">M</div>
      <div>
        <div class="logo-text">Monety</div>
        <div class="logo-sub">Soluciones financieras que te respaldan</div>
      </div>
    </div>
    <div style="text-align:right;font-size:9pt;color:#666">
      <div><strong>Folio:</strong> ${sol.folio}</div>
      <div><strong>Fecha:</strong> ${fechaDoc}</div>
    </div>
  </div>

  <!-- TÍTULO -->
  <p class="contrato-title">
    CONTRATO DE MUTUO CON INTERÉS QUE CELEBRAN POR UNA PARTE ${MUTUANTE.nombre},
    REPRESENTADA POR SU ${MUTUANTE.cargo.toUpperCase()}, LA C. ${MUTUANTE.rep},
    A QUIEN EN LO SUCESIVO SE LE DENOMINARÁ COMO EL MUTUANTE; Y POR LA OTRA EL(LA)
    C. ${nombre}, POR SU PROPIO DERECHO, A QUIEN EN LO SUCESIVO SE LE DENOMINARÁ
    EL MUTUARIO, Y A QUIENES DE MANERA CONJUNTA SE LES DENOMINARÁ LAS PARTES,
    QUIENES SE SUJETAN AL TENOR DE LAS SIGUIENTES DECLARACIONES Y CLÁUSULAS:
  </p>

  <!-- DECLARACIONES -->
  <p class="contrato-section">D E C L A R A C I O N E S</p>

  <p class="contrato-p"><strong>A. EL MUTUANTE DECLARA, POR CONDUCTO DE SU REPRESENTANTE LEGAL:</strong></p>
  <p class="contrato-p"><strong>a.</strong> Ser una persona moral debidamente constituida de conformidad con las Leyes de los Estados Unidos Mexicanos, lo cual acredita con el ${MUTUANTE.notario}</p>
  <p class="contrato-p">Que su representante legal cuenta con las facultades suficientes y necesarias para obligar a su representada en los términos del presente contrato según se desprende en el ${MUTUANTE.notario2}</p>
  <p class="contrato-p"><strong>b.</strong> Que señala como domicilio para efectos del presente contrato el ubicado en ${MUTUANTE.domicilio}.</p>
  <p class="contrato-p"><strong>c.</strong> Que su clave de Registro Federal de Contribuyentes es <strong>${MUTUANTE.rfc}</strong>, expedida a su favor por el Servicio de Administración Tributaria.</p>
  <p class="contrato-p"><strong>d.</strong> La celebración y el cumplimiento del presente contrato están comprendidos dentro de su objeto social y no violan ni constituyen un incumplimiento de cualquier disposición de sus estatutos sociales, convenios, contratos, licencia o cualquier Ley, reglamento, orden o decreto de cualquier autoridad.</p>
  <p class="contrato-p"><strong>e.</strong> Que los recursos con los que solventa la naturaleza del presente Contrato son de procedencia lícita, obtenidos a través de medios honestos por medio del desarrollo de actividades económicas permitidas por la ley.</p>

  <p class="contrato-p" style="margin-top:16px"><strong>B. EL MUTUARIO DECLARA, PROPIO DERECHO:</strong></p>
  <p class="contrato-p"><strong>a.</strong> Que tiene pleno goce de todas las aptitudes y facultades físicas como legales para ser capaz de la celebración del contrato.</p>
  <p class="contrato-p"><strong>b.</strong> Que se identifica con credencial para votar expedida a su favor por el Instituto Nacional Electoral (INE)${curp && curp !== '(CURP pendiente de registrar)' ? `, con CURP: <strong>${curp}</strong>` : ''}.</p>
  <p class="contrato-p"><strong>c.</strong> Que es de su entera voluntad celebrar el presente contrato, sujetándose a los términos y condiciones que más adelante se detallan.</p>

  <p class="contrato-p" style="margin-top:16px">Expuesto lo anterior, LAS PARTES se reconocen la personalidad con la que comparecen y en virtud de lo dispuesto en las declaraciones anteriores, manifiestan que es su voluntad celebrar el presente Contrato, de acuerdo con las siguientes:</p>

  <!-- CLÁUSULAS -->
  <p class="contrato-section">C L Á U S U L A S</p>

  <p class="clausula"><span class="clausula-title">PRIMERA. OBJETO.</span> EL MUTUANTE otorga en beneficio de EL MUTUARIO, en calidad de mutuo con interés, la cantidad de ${montoTxt}.</p>

  <p class="clausula"><span class="clausula-title">SEGUNDA. INTERÉS.</span> LAS PARTES convienen que el presente Contrato genera la obligación para EL MUTUARIO de pagar a EL MUTUANTE un INTERÉS del ${(tasaMens * 100).toFixed(1)}% (${numberToWords(Math.round(tasaMens * 1000)).toUpperCase()} PUNTO ${String(Math.round(tasaMens * 1000) % 10).toUpperCase()} POR CIENTO) por la cantidad otorgada, de acuerdo con lo dispuesto en el artículo 2395 del Código Civil del Distrito Federal, dando un total de préstamo de ${totalTxt}, el cual ya contempla el Impuesto al Valor Agregado correspondiente.</p>

  <p class="clausula"><span class="clausula-title">TERCERA. VIGENCIA.</span> La vigencia del presente Contrato comprenderá a partir de su fecha de firma y concluirá el día ${fechaFin}, quedando total y completamente perfeccionado; obligándose EL MUTUARIO a devolver a EL MUTUANTE la suma de dinero descrita en la primera Cláusula, teniendo como plazo máximo la fecha establecida como término de vigencia del presente contrato.</p>

  <p class="clausula"><span class="clausula-title">CUARTA. DEVOLUCIÓN.</span> EL MUTUARIO se obliga a devolver a EL MUTUANTE en su integridad la suma dispuesta a que se refiere la Cláusula Primera, en los términos y lugar convenido previamente por EL MUTUANTE.</p>

  <p class="clausula"><span class="clausula-title">QUINTA. CESIÓN DE DEUDA.</span> EL MUTUARIO, con el fin de garantizar el cumplimiento de su obligación podrá designar a personas físicas o morales, sin necesidad de obtener el consentimiento expreso de EL MUTUANTE, para que realicen la devolución de la suma objeto del presente Contrato. En caso de incumplimiento en el pago por la persona designada por EL MUTUARIO, esto no lo eximirá de la obligación de pago contraída en el presente Contrato.</p>

  <p class="clausula"><span class="clausula-title">SEXTA. FORMA DE PAGO.</span> EL MUTUARIO pagará a EL MUTUANTE la cantidad de ${formaPago} EL MUTUANTE otorgará a EL MUTUARIO el dinero objeto del presente contrato mediante depósito bancario o transferencia electrónica a través del Sistema de Pagos Electrónicos Interbancarios (SPEI) a la cuenta que EL MUTUARIO le señale para tal efecto.</p>

  <p class="clausula"><span class="clausula-title">SÉPTIMA. MODIFICACIONES.</span> LAS PARTES convienen que el Contrato no podrá modificarse en cuanto a su contenido y alcance salvo convenio por escrito firmado por LAS PARTES. Toda modificación deberá ser notificada por escrito y quedará incorporada como parte integral del presente Contrato.</p>

  <p class="clausula"><span class="clausula-title">OCTAVA. TERMINACIÓN ANTICIPADA.</span> LAS PARTES convienen que el presente Contrato podrá darse por terminado de manera anticipada, siempre que EL MUTUARIO devuelva en su totalidad la suma de dinero descrita en la primera Cláusula, antes de la fecha de terminación.</p>

  <p class="clausula"><span class="clausula-title">NOVENA. INFORMACIÓN CONFIDENCIAL.</span> LAS PARTES convienen que toda la información que se transmita o genere con motivo de la celebración del presente Contrato, así como la información y especificaciones técnicas relacionadas con el mismo, serán manejadas como Información Confidencial. Ninguna de LAS PARTES podrá divulgar dicha información en ningún momento, aún después de la fecha de terminación del mismo.</p>

  <p class="clausula"><span class="clausula-title">DÉCIMA. AUSENCIA DE VICIOS.</span> Bajo protesta de decir verdad, LAS PARTES manifiestan que en el presente Contrato no existe error, dolo, violencia, lesión o enriquecimiento ilegítimo, ni mala fe, por lo que renuncian a invocar cualquiera de estas causales para solicitar la nulidad o rescisión del mismo.</p>

  <p class="clausula"><span class="clausula-title">DÉCIMA PRIMERA. RECURSOS DE PROCEDENCIA ILÍCITA.</span> LAS PARTES se liberan de toda sanción o responsabilidad que pudiera derivarse del incumplimiento de las disposiciones previstas en la Ley Federal para la Prevención e Identificación de Operaciones con Recursos de Procedencia Ilícita y su Reglamento.</p>

  <p class="clausula"><span class="clausula-title">DÉCIMA SEGUNDA. COSTOS Y GASTOS.</span> LAS PARTES serán responsables de cubrir por su cuenta y cargo los costos, gastos, honorarios y/o comisiones en que incurran con motivo de la celebración del presente Contrato.</p>

  <p class="clausula"><span class="clausula-title">DÉCIMA TERCERA. ENCABEZADOS.</span> Los encabezados de las cláusulas se han colocado por conveniencia de LAS PARTES con el exclusivo propósito de facilitar su lectura y no necesariamente definen ni limitan el contenido de las mismas.</p>

  <p class="clausula"><span class="clausula-title">DÉCIMA CUARTA. JURISDICCIÓN.</span> LAS PARTES se someten expresamente a las leyes y a la jurisdicción de los Tribunales de la Ciudad de México que serán los únicos competentes para conocer de cualquier juicio o reclamación derivado del presente Contrato, renunciando a cualquier fuero que pudiera corresponderles.</p>

  <p class="contrato-p" style="margin-top:20px">
    Leído por LAS PARTES el contenido del presente Contrato, y sabedoras de las consecuencias legales que el mismo establece, lo ratifican en todas sus partes y firman por duplicado en la Ciudad de México, el ${fechaDoc}.
  </p>

  <!-- FIRMAS -->
  <div class="firmas-grid">
    <div class="firma-block">
      <div class="firma-party">EL MUTUANTE</div>
      <div class="firma-name" style="margin-bottom:48px">${MUTUANTE.nombre}</div>
      <div class="firma-line"></div>
      <div class="firma-party">REPRESENTANTE LEGAL</div>
      <div class="firma-name">${MUTUANTE.rep}</div>
    </div>
    <div class="firma-block">
      <div class="firma-party">EL MUTUARIO</div>
      <div class="firma-name" style="margin-bottom:48px">${nombre}</div>
      <div class="firma-line"></div>
      <div class="firma-party">Por su propio derecho</div>
      <div class="firma-name">&nbsp;</div>
    </div>
  </div>

  <!-- FOOTER -->
  <div class="doc-footer">
    <span>📸 ${CONTACTO.ig}</span>
    <span>🌐 ${CONTACTO.web}</span>
    <span>💼 ${CONTACTO.li}</span>
  </div>

</div>
<script>
  if (new URLSearchParams(window.location.search).get('print') === '1') {
    window.onload = () => setTimeout(() => window.print(), 600);
  }
</script>
</body>
</html>`;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════
// GET /api/v1/documentos/:id/info  — Devuelve JSON con estado
// ═══════════════════════════════════════════════════════════════
router.get('/:id/info',
  authMiddleware,
  param('id').isUUID(),
  handleValidationErrors,
  async (req, res, next) => {
    try {
      const sol = await getDatosSolicitud(req.params.id);
      if (!sol) return res.status(404).json({ ok: false, message: 'No encontrada' });
      res.json({
        ok: true,
        folio:    sol.folio,
        estado:   sol.estado,
        nombre:   sol.nombre_completo,
        monto:    sol.monto_aprobado || sol.monto_solicitado,
        plazo:    sol.plazo_meses,
        aprobada: ['PRE_APROBADA','APROBADA'].includes(sol.estado),
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
