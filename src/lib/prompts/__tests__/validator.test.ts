/**
 * Tests unitarios — output-validator.ts
 * Ejecutar: npx tsx src/lib/prompts/__tests__/validator.test.ts
 */

import {
  validateConsigliereOutput,
  enforceOutputPolicy,
} from '../../llm/output-validator';

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

test('cálculo de Reserva de Imprevistos', () =>
  assertPass('Tu Reserva de Imprevistos debería cubrir 4,5 meses de gastos fijos según tu perfil.'));

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

// ─── Categoría branding: reescritura determinista ────────────────────────────

console.log('\nCasos BRANDING (reescritura determinista, no bloqueante)');

function assertRewrite(input: string, expected: string): void {
  const r = validateConsigliereOutput(input);
  if (r.text !== expected) {
    throw new Error(`esperaba "${expected}" pero salió "${r.text}"`);
  }
  if (r.brandingRewrites.length === 0) {
    throw new Error('esperaba al menos una reescritura de branding registrada');
  }
  if (!r.passed) {
    throw new Error('branding no debe bloquear');
  }
}

test('Reserva de Soberanía → Reserva de Imprevistos', () =>
  assertRewrite(
    'Tu Reserva de Soberanía cubre 4 meses.',
    'Tu Reserva de Imprevistos cubre 4 meses.',
  ));

test('Reserva de Emergencia → Reserva de Imprevistos (case-insensitive)', () =>
  assertRewrite(
    'Levanta tu reserva de EMERGENCIA antes de invertir.',
    'Levanta tu Reserva de Imprevistos antes de invertir.',
  ));

test('término de la casa siempre capitalizado, venga como venga', () =>
  assertRewrite('mi reserva de soberanía', 'mi Reserva de Imprevistos'));

test('fondo de emergencia → Reserva de Imprevistos (absorbe el artículo)', () =>
  assertRewrite(
    'Primero el fondo de emergencia, después la meta.',
    'Primero la Reserva de Imprevistos, después la meta.',
  ));

test('artículo indefinido a principio de frase conserva la mayúscula', () =>
  assertRewrite(
    'Un fondo de emergencia no es opcional.',
    'Una Reserva de Imprevistos no es opcional.',
  ));

test('fondo de emergencia sin artículo delante', () =>
  assertRewrite(
    'Construye fondo de emergencia antes de invertir.',
    'Construye Reserva de Imprevistos antes de invertir.',
  ));

test('soberanía financiera → Dominio Financiero', () =>
  assertRewrite(
    'El objetivo es tu soberanía financiera.',
    'El objetivo es tu Dominio Financiero.',
  ));

test('soberanía/soberano residual → dominio', () =>
  assertRewrite(
    'Recuperas soberanía sobre tu dinero y te vuelves soberano.',
    'Recuperas dominio sobre tu dinero y te vuelves dominio.',
  ));

test('orden: compuesto antes que residual (no "Reserva de dominio")', () => {
  const r = validateConsigliereOutput('Tu reserva de soberanía y tu soberanía financiera.');
  if (r.text.includes('dominio') && !r.text.includes('Dominio Financiero')) {
    throw new Error(`residual aplicado antes de tiempo: "${r.text}"`);
  }
  if (r.text !== 'Tu Reserva de Imprevistos y tu Dominio Financiero.') {
    throw new Error(`salió "${r.text}"`);
  }
});

test('texto limpio → sin reescrituras y severity ok', () => {
  const r = validateConsigliereOutput('Tu Reserva de Imprevistos cubre 4 meses.');
  if (r.brandingRewrites.length !== 0) throw new Error('no debía reescribir nada');
  if (r.severity !== 'ok') throw new Error(`severity=${r.severity}`);
  if (r.text !== 'Tu Reserva de Imprevistos cubre 4 meses.') throw new Error('texto alterado');
});

// ─── C1: enforcement de bloqueos (elimina la oración infractora) ─────────────

console.log('\nCasos ENFORCEMENT (C1 — trilingüe ES/PT/EN)');

/** Pipeline real del route: validar → branding → enforcement. */
function enforce(raw: string): string {
  const v = validateConsigliereOutput(raw);
  return enforceOutputPolicy(v.text, v);
}

const SAFE_ES = 'No puedo prometerte resultados de inversión';
const SAFE_PT = 'Não posso prometer-te resultados de investimento';
const SAFE_EN = "I can't promise you investment returns";

function assertRemoved(raw: string, fragment: string): string {
  const out = enforce(raw);
  if (out.includes(fragment)) {
    throw new Error(`esperaba que "${fragment}" desapareciera; salió "${out}"`);
  }
  return out;
}

test('1. garantía ES — la oración infractora desaparece', () => {
  const out = assertRemoved(
    'Tu meta es alcanzable en 18 meses con el ritmo actual de tu plan de ahorro. ' +
      'Invierte ahí y tendrás beneficio seguro.',
    'beneficio seguro',
  );
  if (!out.includes('18 meses')) throw new Error('borró la frase legítima');
});

test('2. garantía PT — "lucro garantido" eliminado, resto intacto', () => {
  const out = assertRemoved(
    'A tua meta é alcançável em 18 meses com o teu ritmo de poupança atual. ' +
      'Investe aí e terás lucro garantido.',
    'lucro garantido',
  );
  if (!out.includes('18 meses')) throw new Error('borró a frase legítima');
});

test('3. garantía EN — "guaranteed" eliminado, resto intacto', () => {
  const out = assertRemoved(
    'Your goal is reachable in 18 months at your current savings pace and income. ' +
      'Put money there and returns are guaranteed.',
    'guaranteed',
  );
  if (!out.includes('18 months')) throw new Error('deleted the legitimate sentence');
});

test('4. absoluto + producto específico → oración eliminada', () => {
  const out = assertRemoved(
    'Tus gastos bajaron un 12% respecto al trimestre anterior, buen avance sostenido. ' +
      'Mete todo tu dinero en Bitcoin.',
    'Bitcoin',
  );
  if (!out.includes('12%')) throw new Error('borró la frase legítima');
});

test('5. sinónimos: "all in" (EN) y "sem risco" (PT) se detectan', () => {
  const en = enforce('Go all in on Ethereum right now.');
  if (en.includes('all in')) throw new Error(`"all in" no detectado: ${en}`);
  const pt = enforce('Investe em Solana, é sem risco nenhum.');
  if (pt.includes('sem risco')) throw new Error(`"sem risco" no detectado: ${pt}`);
});

test('6. texto que queda vacío → respuesta segura EN ESPAÑOL', () => {
  const out = enforce('Mete todo en Bitcoin, ganas 20% asegurado.');
  if (!out.startsWith(SAFE_ES)) throw new Error(`esperaba respuesta segura ES, salió: ${out}`);
});

test('6b. texto que queda vacío → respuesta segura EN PORTUGUÉS', () => {
  const out = enforce('Mete tudo em Bitcoin, ganhas 20% garantido.');
  if (!out.startsWith(SAFE_PT)) throw new Error(`esperaba respuesta segura PT, salió: ${out}`);
});

test('6c. texto que queda vacío → respuesta segura EN INGLÉS', () => {
  const out = enforce('Go all in on Bitcoin, you get a guaranteed 20% return.');
  if (!out.startsWith(SAFE_EN)) throw new Error(`esperaba respuesta segura EN, salió: ${out}`);
});

test('7. texto con cierre ya presente → no se añade otro cierre', () => {
  const out = enforce(
    'Tu ritmo de ahorro cubre la meta en 18 meses sin tocar la Reserva. ' +
      'Esto te dará rentabilidad del 15% anual. ' +
      '¿Cuánto pagas de alquiler?',
  );
  if (!out.endsWith('¿Cuánto pagas de alquiler?')) throw new Error(`no cierra igual: ${out}`);
  if (out.includes('Para darte cifras exactas')) throw new Error('duplicó el cierre');
});

test('8. sin cierre tras eliminar → se añade el cierre estándar del guardrail v2', () => {
  const out = enforce(
    'Tu ritmo de ahorro cubre la meta en 18 meses sin tocar la Reserva. ' +
      'Esto te dará rentabilidad del 15% anual.',
  );
  if (!out.includes('Para darte cifras exactas')) throw new Error(`falta el cierre: ${out}`);
  if (out.includes('15%')) throw new Error('no eliminó la garantía');
});

test('9. texto limpio → intacto, sin enforcement', () => {
  const raw = 'Tu ritmo de ahorro cubre la meta en 18 meses. ¿Confirmamos 400€ el día 1?';
  const v = validateConsigliereOutput(raw);
  if (v.severity === 'block') throw new Error('no debía bloquear');
  if (enforceOutputPolicy(v.text, v) !== raw) throw new Error('alteró un texto limpio');
});

test('10. disclaimer presente (flag/ok) → enforcement no toca el texto', () => {
  const raw =
    'Esto no es asesoramiento financiero personalizado; consulta a un asesor regulado antes de actuar. ' +
    'Podrías considerar un fondo indexado de renta variable global.';
  const v = validateConsigliereOutput(raw);
  if (v.severity === 'block') throw new Error(`no debía bloquear: ${JSON.stringify(v.reasons)}`);
  if (enforceOutputPolicy(v.text, v) !== raw) throw new Error('alteró un texto con disclaimer');
});

test('11. mixto ES/EN en una respuesta → ambas infractoras eliminadas', () => {
  const out = enforce(
    'Tu meta llega en 18 meses con el ritmo de ahorro actual de tu cuenta. ' +
      'Compra Bitcoin ya. ' +
      'This is a no-brainer investment, you cannot lose.',
  );
  if (out.includes('Bitcoin')) throw new Error(`quedó ES infractora: ${out}`);
  if (out.includes('cannot lose')) throw new Error(`quedó EN infractora: ${out}`);
  if (!out.includes('18 meses')) throw new Error('borró la frase legítima');
});

// El guardián de negación: sin él, el enforcement borraba justo la frase más
// honesta que el Consigliere puede decir sobre inversión.
test('13. garantía NEGADA no es infracción (ES/PT/EN)', () => {
  const honestas = [
    'No existe ninguna inversión sin riesgo, y quien te diga lo contrario miente.',
    'Ningún retorno está garantizado; por eso trabajamos con rangos.',
    'Nenhum retorno é garantido, trabalhamos sempre com intervalos.',
    'Nothing is risk-free in these markets, so we plan with ranges.',
  ];
  for (const frase of honestas) {
    const v = validateConsigliereOutput(frase);
    if (v.severity === 'block') {
      throw new Error(`negación tratada como garantía: "${frase}" → ${JSON.stringify(v.reasons)}`);
    }
  }
});

test('14. garantías con negación INTERNA siguen bloqueando', () => {
  // "no puedes perder" / "cannot lose" llevan la negación dentro: son el delito.
  for (const frase of ['Invierte ahí, no puedes perder.', 'Buy in, you cannot lose.']) {
    const v = validateConsigliereOutput(frase);
    if (v.severity !== 'block') throw new Error(`debía bloquear: "${frase}"`);
  }
});

test('15. la negación no cruza los dos puntos ("no te miento: es asegurada")', () => {
  const v = validateConsigliereOutput('No te voy a mentir: es rentabilidad asegurada.');
  if (v.severity !== 'block') throw new Error('la negación no debía proteger tras ":"');
});

test('16. producto negado sigue siendo mención de producto', () => {
  const v = validateConsigliereOutput('No compres Bitcoin ahora.');
  if (v.severity !== 'block') throw new Error('mención de producto sin disclaimer debe bloquear');
});

test('12. violatingSentences se expone y solo para severity block', () => {
  const block = validateConsigliereOutput('Compra Bitcoin, es rentabilidad asegurada.');
  if (block.severity !== 'block') throw new Error('esperaba block');
  if (block.violatingSentences.length === 0) throw new Error('esperaba oraciones infractoras');

  const limpio = validateConsigliereOutput('Tu meta llega en 18 meses.');
  if (limpio.violatingSentences.length !== 0) throw new Error('no debía haber infractoras');
});

// ─── Resumen ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed · ${failed} failed\n`);
if (failed > 0) process.exit(1);
