# Command: evaluar-semana

Ejecuta el flujo semanal de evaluación local:
1. Sincroniza intereses con `pnpm spf interests sync` y hace pull.
2. Prepara el batch con `pnpm spf prepare --week <YYYY-Www>`.
3. Lee `data/batches/<YYYY-Www>/batch.md` y evalúa (puedes usar herramientas web si lo necesitas) escribiendo resultados en `data/batches/<YYYY-Www>/scoring.json`.
4. Valida los datos generados usando `pnpm spf collect-batch --week <YYYY-Www>`.
5. Publica el reporte usando `pnpm spf publish --week <YYYY-Www>`.
6. Termina haciendo `pnpm spf interests sync`, un commit y push.
