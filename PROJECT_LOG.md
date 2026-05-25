# PROJECT_LOG — Sovereign CFO / andgcore

## 2026-05-19 — Día 5 (continuación)

### Decisiones de infraestructura
- Flujo 3 capas confirmado: agent/XX → develop → main
- Branch protection: control manual (GitHub Free no soporta
  en repos privados — activar cuando haya ingresos)
- Vercel: 2 ambientes configurados
  PRD: sovereign-cfo.vercel.app (rama main)
  QA: URL preview automática (rama develop)
- Ignored Build Step activo: solo main y develop
  generan deployments en Vercel
- Ramas sincronizadas: todas en bcf10df

### Comandos de merge aprobados por Luis
# Agente → QA:
git checkout develop
git merge agent/XX --no-ff -m "merge: agXX → develop"
git push origin develop

# QA → PRD (solo cuando Luis aprueba):
git checkout main
git merge develop --no-ff -m "release: develop → main"
git push origin main

### Proceso de trabajo por agente (OBLIGATORIO)
1. git branch → verificar estar en agent/XX
2. git fetch origin && git reset --hard origin/main
3. Leer PROJECT_LOG.md y CLAUDE.md
4. Trabajar solo en archivos de su dominio
5. git push origin agent/XX ÚNICAMENTE
   PROHIBIDO: push a main, develop o ramas de otros agentes
6. Reportar Fase 4 y esperar aprobación de Luis

### Merges — solo Luis
agent/XX → develop: validación QA
develop → main: aprobación producción

### Pendientes
- develop URL de preview pendiente de confirmar en Vercel
- tmux + launch-swarm.sh pendiente de instalar
- Motor IDF pendiente de conectar al dashboard
- Migración 007 pendiente de ejecutar en Supabase
