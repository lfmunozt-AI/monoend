/**
 * Tests unitarios — fiscal/portugal.ts
 * Ejecutar: npx tsx src/lib/__tests__/portugal.test.ts
 */

import {
  calcularRetencionIRS,
  getSalarioNeto,
  calcularLiquidezMensual,
} from '../fiscal/portugal';

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

function near(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

function assertNear(actual: number, expected: number, label: string): void {
  if (!near(actual, expected)) {
    throw new Error(`esperado ${expected}, obtenido ${actual}`);
  }
  void label;
}

function assertThrows(fn: () => unknown, label: string): void {
  try {
    fn();
    throw new Error(`debería haber lanzado excepción`);
  } catch (e) {
    if ((e as Error).message === 'debería haber lanzado excepción') throw e;
    void label;
  }
}

// ─── calcularRetencionIRS ────────────────────────────────────────────────────

console.log('\ncalcularRetencionIRS');

test('salario 0 → retención 0', () =>
  assertNear(calcularRetencionIRS(0), 0, ''));

test('salario negativo → retención 0', () =>
  assertNear(calcularRetencionIRS(-500), 0, ''));

test('salario 700€ → escalón 0% → retención 0', () =>
  assertNear(calcularRetencionIRS(700), 0, ''));

test('salario 762€ → escalón 0% → retención 0', () =>
  assertNear(calcularRetencionIRS(762), 0, ''));

test('salario 1000€ → 11.5% → retención 115€', () =>
  assertNear(calcularRetencionIRS(1000), 115, ''));

test('salario 2000€ → 24% → retención 480€', () =>
  assertNear(calcularRetencionIRS(2000), 480, ''));

test('salario 4000€ → 35.5% → retención 1420€', () =>
  assertNear(calcularRetencionIRS(4000), 1420, ''));

test('salario 10000€ → 48% → retención 4800€', () =>
  assertNear(calcularRetencionIRS(10000), 4800, ''));

// ─── getSalarioNeto ──────────────────────────────────────────────────────────

console.log('\ngetSalarioNeto');

test('salario 0 → neto 0', () =>
  assertNear(getSalarioNeto(0), 0, ''));

test('1000€ conta_outrem → neto 775€ (IRS 115 + SS 110)', () =>
  assertNear(getSalarioNeto(1000, 'conta_outrem'), 775, ''));

test('1000€ conta_propria → neto 671€ (IRS 115 + SS 214)', () =>
  assertNear(getSalarioNeto(1000, 'conta_propria'), 671, ''));

test('default tipoEmpleo usa conta_outrem', () =>
  assertNear(getSalarioNeto(1000), getSalarioNeto(1000, 'conta_outrem'), ''));

test('2000€ conta_outrem → neto 1300€ (IRS 480 + SS 220)', () =>
  assertNear(getSalarioNeto(2000, 'conta_outrem'), 1300, ''));

// ─── calcularLiquidezMensual ─────────────────────────────────────────────────

console.log('\ncalcularLiquidezMensual');

test('mes 1 (enero) → solo salario neto', () =>
  assertNear(
    calcularLiquidezMensual(1, 1000, 'conta_outrem'),
    getSalarioNeto(1000, 'conta_outrem'),
    '',
  ));

test('mes 6 (junio) → salario neto × 2 (+ subsidio férias)', () =>
  assertNear(
    calcularLiquidezMensual(6, 1000, 'conta_outrem'),
    getSalarioNeto(1000, 'conta_outrem') * 2,
    '',
  ));

test('mes 11 (noviembre) → salario neto × 2 (+ subsidio Natal)', () =>
  assertNear(
    calcularLiquidezMensual(11, 1000, 'conta_outrem'),
    getSalarioNeto(1000, 'conta_outrem') * 2,
    '',
  ));

test('mes 12 (diciembre) → solo salario neto (sin subsidio)', () =>
  assertNear(
    calcularLiquidezMensual(12, 1000, 'conta_outrem'),
    getSalarioNeto(1000, 'conta_outrem'),
    '',
  ));

test('mes 0 → lanza RangeError', () =>
  assertThrows(() => calcularLiquidezMensual(0, 1000, 'conta_outrem'), ''));

test('mes 13 → lanza RangeError', () =>
  assertThrows(() => calcularLiquidezMensual(13, 1000, 'conta_outrem'), ''));

// ─── Resumen ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed · ${failed} failed\n`);
if (failed > 0) process.exit(1);
