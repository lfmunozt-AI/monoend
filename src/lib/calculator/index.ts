// Motor financiero de ModeloCFO — punto de entrada del paquete.
//
// El CÓDIGO calcula, el modelo solo redacta. `buildVerifiedContext` produce el
// bloque de cifras verificadas para el prompt y la lista `cifrasCalculadas` que
// el validador del guardarraíl usa para aprobar coincidencias exactas.

export {
  sobrante,
  porcentajeDe,
  regla503020,
  fondoEmergencia,
  proyeccion,
  tiempoHastaMeta,
  ratioDeuda,
  interesCompuesto,
  type CalcValor,
  type CalcRegla,
  type CalcError,
  type CalcErrorCode,
} from "./operations";

export {
  buildVerifiedContext,
  type VerifiedContext,
} from "./orchestrator";
