const { evaluar, generarAmortizacion } = require('../src/services/scoringService');

describe('scoringService.evaluar()', () => {
  const base = {
    salarioNeto:     9465,
    historial:       'BUENO',
    antiguedadAnos:  0.2,
    montoSolicitado: 15000,
    plazoMeses:      12,
    gastos:          10000,
    pagoDeudas:      0,
    tipoCredito:     'NOMINA',
  };

  test('rechaza cuando la capacidad de pago es negativa', () => {
    const r = evaluar(base);
    expect(r.aprobado).toBe(false);
    expect(r.financiero.capacidadPago).toBeLessThan(0);
  });

  test('aprueba con perfil sólido', () => {
    const r = evaluar({
      ...base,
      salarioNeto:    30000,
      historial:      'EXCELENTE',
      antiguedadAnos: 3,
      gastos:         8000,
    });
    expect(r.aprobado).toBe(true);
    expect(r.puntajeTotal).toBeGreaterThanOrEqual(80);
  });

  test('puntaje máximo = 150 con perfil ideal', () => {
    const r = evaluar({
      ...base,
      salarioNeto:    50000,
      historial:      'EXCELENTE',
      antiguedadAnos: 5,
      gastos:         5000,
      montoSolicitado: 3000,
      plazoMeses:     3,
    });
    expect(r.puntos.ingreso).toBe(50);
    expect(r.puntos.historial).toBe(40);
    expect(r.puntos.antiguedad).toBe(30);
    expect(r.puntos.capacidadPago).toBe(30);
    expect(r.puntajeTotal).toBe(150);
    expect(r.ranking).toBe('AAA');
  });

  test('puntaje mínimo aprobatorio es 80', () => {
    const r = evaluar({
      ...base,
      salarioNeto:    9000,
      historial:      'BUENO',
      antiguedadAnos: 1,
      gastos:         3000,
      montoSolicitado: 5000,
      plazoMeses:     6,
    });
    expect(r.puntajeTotal).toBeGreaterThanOrEqual(80);
    expect(r.aprobado).toBe(true);
  });

  test('devuelve motivo de rechazo cuando no aprueba', () => {
    const r = evaluar({ ...base });
    expect(r.motivoRechazo).toBeTruthy();
  });
});

describe('scoringService.generarAmortizacion()', () => {
  const tabla = generarAmortizacion({
    monto: 15000, plazo: 12, tipoCredito: 'NOMINA',
  });

  test('genera exactamente 12 periodos', () => {
    expect(tabla).toHaveLength(12);
  });

  test('primer saldo inicial es el monto original', () => {
    expect(tabla[0].saldoInicial).toBe(15000);
  });

  test('saldo insoluto final es ≈ 0', () => {
    expect(tabla[11].saldoInsoluto).toBeLessThan(50);
  });

  test('pago fijo es consistente en todos los periodos', () => {
    const pagos = tabla.map(r => r.pagoFijo);
    const max   = Math.max(...pagos);
    const min   = Math.min(...pagos);
    expect(max - min).toBeLessThan(1); // diferencia centavos por redondeo
  });
});
