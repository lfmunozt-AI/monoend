/**
 * Tests unitarios — output-validator.ts
 * Ejecutar: npx tsx src/lib/prompts/__tests__/validator.test.ts
 */

import { validateConsigliereOutput } from '../../llm/output-validator';

// ─── Mini test runner ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗  ${name}: ${(e as Error).message}`);
    failed++;
  }
}

function assertPass(text: string): void {
  const r = validateConsigliereOutput(text);
  if (!r.passed || r.severity === 'block') {
    throw new Error(
      `esperaba PASS pero severity=${r.severity} reasons=${JSON.stringify(r.reasons)}`,
    );
  }
}

function assertBlock(text: string): void {
  const r = validateConsigliereOutput(text);
  if (r.passed || r.severity !== 'block') {
    throw new Error(
      `esperaba BLOCK pero severity=${r.severity} passed=${r.passed} reasons=${JSON.stringify(r.reasons)}`,
    );
  }
}

// ─── 10 casos PASS ───────────────────────────────────────────────────────────

console.log('\nCasos PASS (deben devolver passed: true)');

test('recomendación neutra con importes', () =>
  assertPass('Para tu meta de €40,000, recomiendo aumentar ahorro mensual a €1,200.'));

test('diagnóstico de Fuga de Poder', () =>
  assertPass('Detecté una Fuga de Poder de €87 en suscripciones no usadas el mes pasado.'));

test('cálculo de Reserva de Soberanía', () =>
  assertPass('Tu Reserva de Soberanía debería cubrir 4,5 meses de gastos fijos según tu perfil.'));

test('proyección Escenario de Poder', () =>
  assertPass('El Escenario de Poder con ahorro de €800/mes proyecta meta cumplida en 14 meses.'));

test('mención de categoría genérica con disclaimer', () =>
  assertPass(
    'Esto no es asesoramiento financiero personalizado; consulta a un asesor regulado antes de actuar. Podrías considerar un fondo indexado de renta variable global una vez tengas la Reserva consolidada.',
  ));

test('petición de documentos', () =>
  assertPass(
    'Antes de avanzar, necesito el extracto bancario de los últimos 3 meses para validar tu ritmo real de ahorro.',
  ));

test('definición de Hito', () =>
  assertPass('El siguiente Hito es cerrar el mes con saldo positivo y sin nuevas Fugas de Poder.'));

test('ratio deuda/ingreso sin recomendación de producto', () =>
  assertPass(
    'Tu cuota de deuda actual representa el 38% del ingreso; conviene reducirla por debajo del 30% antes de mover capital a inversión.',
  ));

test('cuantificación de Fuga de Poder', () =>
  assertPass(
    'Detecto que en los últimos 30 días tu gasto en restaurantes pasó de €120 a €310; eso es una Fuga de Poder de €190.',
  ));

test('solicitud de perfil fiscal', () =>
  assertPass(
    'Necesito tu perfil fiscal completo —país, régimen, retención— para construir un Escenario de Poder a más de 12 meses.',
  ));

// ─── 10 casos FAIL (severity: 'block') ───────────────────────────────────────

console.log('\nCasos FAIL (deben devolver passed: false, severity: block)');

test('cripto específica sin disclaimer', () =>
  assertBlock('Te recomiendo invertir tus €5,000 en Bitcoin.'));

test('acción específica + garantía de retorno', () =>
  assertBlock('Compra acciones de Tesla, te van a dar 20% este año.'));

test('broker específico + recomendación absoluta', () =>
  assertBlock('Abre cuenta en Revolut, es la mejor.'));

test('cripto específica con imperativo', () =>
  assertBlock('Invierte en Ethereum ahora que está barato.'));

test('ticker de ETF + imperativo absoluto', () =>
  assertBlock('El ETF VWCE es el mejor para tu perfil, métete sin dudar.'));

test('exchange + cripto en una sola jugada', () =>
  assertBlock('Tu mejor opción es pasar tu dinero a Binance y comprar Solana.'));

test('garantizado + acción específica + porcentaje', () =>
  assertBlock('Garantizado: si compras NVIDIA ahora vas a ganar 30% en 6 meses.'));

test('broker + rentabilidad asegurada', () =>
  assertBlock(
    'Abre cuenta en eToro y copia al trader top, esto te dará rentabilidad del 15% anual.',
  ));

test('imperativo "vende todo" + broker concreto', () =>
  assertBlock('Vende todo y mete todo en oro físico a través de BullionVault.'));

test('broker + ETF + garantía de rentabilidad', () =>
  assertBlock(
    'Si abres una cuenta en Trade Republic y compras el ETF IWDA, tienes asegurado un 8% anual.',
  ));

// ─── Resumen ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed · ${failed} failed\n`);
if (failed > 0) process.exit(1);
