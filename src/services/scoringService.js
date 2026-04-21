/**
 * scoringService.js
 * Implementa el algoritmo de evaluación crediticia de Algoritmo.xlsx
 *
 * Criterios y puntajes máximos:
 *   Ingreso neto          → 50 pts
 *   Historial crediticio  → 40 pts
 *   Antigüedad laboral    → 30 pts
 *   Capacidad de pago     → 30 pts
 *   TOTAL MÁXIMO          → 150 pts  (mínimo aprobatorio: 80 pts)
 */

const PUNTAJE_MINIMO = 80;

const RANKING_MAP = {
  AAA: [110, 150],
  AA:  [90,  109],
  A:   [80,   89],
  BB:  [70,   79],
  B:   [60,   69],
  C:   [50,   59],
  D:   [40,   49],
  E:   [0,    39],
};

/** Puntaje según ingreso neto mensual */
function ptsIngreso(ingresoNeto) {
  if (ingresoNeto >  25427) return 50;
  if (ingresoNeto >= 12713) return 40;
  if (ingresoNeto >=  8475) return 30;
  return 20;
}

/** Puntaje según historial crediticio declarado */
function ptsHistorial(historial) {
  const tabla = {
    EXCELENTE:  40,
    MUY_BUENO:  30,
    BUENO:      20,
    MEDIO_BAJO: 10,
  };
  return tabla[historial] ?? 10;
}

/** Puntaje según antigüedad laboral en años */
function ptsAntiguedad(antiguedadAnos) {
  if (antiguedadAnos >  2) return 30;
  if (antiguedadAnos >= 1) return 20;
  return 10;
}

/** Puntaje según ratio capacidad de pago (pago_mensual / salario_neto) */
function ptsCapacidadPago(ratio) {
  if (ratio <  0.30) return 30;
  if (ratio <  0.40) return 20;
  return 10;
}

/** Ranking a partir del puntaje total */
function calcularRanking(puntaje) {
  for (const [rank, [min, max]] of Object.entries(RANKING_MAP)) {
    if (puntaje >= min && puntaje <= max) return rank;
  }
  return 'E';
}

/**
 * Evaluación completa de una solicitud.
 *
 * @param {object} datos
 * @param {number} datos.salarioNeto            Salario mensual neto en MXN
 * @param {string} datos.historial              EXCELENTE | MUY_BUENO | BUENO | MEDIO_BAJO
 * @param {number} datos.antiguedadAnos         Años de antigüedad laboral
 * @param {number} datos.montoSolicitado        Monto del préstamo en MXN
 * @param {number} datos.plazoMeses             Plazo en meses
 * @param {number} datos.gastos                 Gastos personales mensuales
 * @param {number} datos.pagoDeudas             Pago mensual de deudas existentes
 * @param {string} datos.tipoCredito            NOMINA | PERSONAL
 */
function evaluar(datos) {
  const {
    salarioNeto,
    historial,
    antiguedadAnos,
    montoSolicitado,
    plazoMeses,
    gastos          = 0,
    pagoDeudas      = 0,
    tipoCredito     = 'NOMINA',
  } = datos;

  // ── 1. Calcular pago mensual con la fórmula del simulador ─────────
  const tasaMensual    = tipoCredito === 'NOMINA' ? 0.043 : 0.05;
  const tasaConIva     = tasaMensual * 1.16;
  const pagoMensual    = montoSolicitado *
    (tasaConIva * Math.pow(1 + tasaConIva, plazoMeses)) /
    (Math.pow(1 + tasaConIva, plazoMeses) - 1);

  // ── 2. Capacidad de pago disponible ───────────────────────────────
  const flujoDisponible    = salarioNeto - gastos - pagoDeudas;
  const capacidadPago      = flujoDisponible - pagoMensual;
  const ratio              = pagoMensual / salarioNeto;

  // ── 3. Puntajes por criterio ──────────────────────────────────────
  const puntos = {
    ingreso:        ptsIngreso(salarioNeto),
    historial:      ptsHistorial(historial),
    antiguedad:     ptsAntiguedad(antiguedadAnos),
    capacidadPago:  ptsCapacidadPago(ratio),
  };
  const puntajeTotal = Object.values(puntos).reduce((a, b) => a + b, 0);

  // ── 4. Resultado ──────────────────────────────────────────────────
  const aprobado = puntajeTotal >= PUNTAJE_MINIMO && capacidadPago > 0;
  const ranking  = calcularRanking(puntajeTotal);

  // ── 5. Tasas y CAT ────────────────────────────────────────────────
  const tasaAnual = tasaMensual * 12;
  const cat       = tipoCredito === 'NOMINA' ? 0.59856 : 0.72;

  // ── 6. Meses de crédito vs salario (indicador de riesgo) ─────────
  const mesesCreditoVsSalario = montoSolicitado / salarioNeto;
  const mesesRiesgo           = plazoMeses - (montoSolicitado / pagoMensual);

  return {
    aprobado,
    ranking,
    puntajeTotal,
    puntajeMinimo: PUNTAJE_MINIMO,
    puntos,
    financiero: {
      pagoMensual:           Math.round(pagoMensual * 100) / 100,
      tasaMensual,
      tasaAnual,
      cat,
      flujoDisponible,
      capacidadPago,
      ratio:                 Math.round(ratio * 10000) / 10000,
      mesesCreditoVsSalario: Math.round(mesesCreditoVsSalario * 100) / 100,
      mesesRiesgo:           Math.round(mesesRiesgo * 100) / 100,
      totalPagar:            Math.round(pagoMensual * plazoMeses * 100) / 100,
    },
    motivoRechazo: !aprobado
      ? puntajeTotal < PUNTAJE_MINIMO
        ? `Puntaje insuficiente: ${puntajeTotal}/${PUNTAJE_MINIMO}`
        : 'Capacidad de pago negativa'
      : null,
  };
}

/**
 * Genera la tabla de amortización completa (Simulador_Crédito.xlsx).
 */
function generarAmortizacion({ monto, plazo, tipoCredito = 'NOMINA', fechaInicio }) {
  const tasaMensual = tipoCredito === 'NOMINA' ? 0.043 : 0.05;
  const iva         = 0.16;
  const tasaConIva  = tasaMensual * (1 + iva);

  const pagoFijo = monto *
    (tasaConIva * Math.pow(1 + tasaConIva, plazo)) /
    (Math.pow(1 + tasaConIva, plazo) - 1);

  const tabla = [];
  let saldo   = monto;
  const inicio = fechaInicio ? new Date(fechaInicio) : new Date();

  for (let i = 1; i <= plazo; i++) {
    const interesMes = saldo * tasaMensual;
    const ivaMes     = interesMes * iva;
    const capital    = pagoFijo - interesMes - ivaMes;

    const fechaPago = new Date(inicio);
    fechaPago.setMonth(fechaPago.getMonth() + i);

    tabla.push({
      periodo:       i,
      fechaPago:     fechaPago.toISOString().slice(0, 10),
      saldoInicial:  Math.round(saldo * 100) / 100,
      capital:       Math.round(capital * 100) / 100,
      interes:       Math.round(interesMes * 100) / 100,
      iva:           Math.round(ivaMes * 100) / 100,
      pagoFijo:      Math.round(pagoFijo * 100) / 100,
      pagoTotal:     Math.round(pagoFijo * 100) / 100,
      saldoInsoluto: Math.round((saldo - capital) * 100) / 100,
    });
    saldo -= capital;
  }
  return tabla;
}

module.exports = { evaluar, generarAmortizacion, calcularRanking };
