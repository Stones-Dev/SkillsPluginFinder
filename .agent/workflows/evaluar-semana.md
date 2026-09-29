# Workflow: Evaluar Semana

1. `git pull` para obtener los últimos candidatos de la semana.
2. Ejecutar `pnpm spf interests sync` para sincronizar `Intereses.md` con `interests.yaml` e importar `Catalogo.md`.
3. Ejecutar `pnpm spf prepare --week <YYYY-Www>` para crear el fichero `batch.md` de la semana en `data/batches/<YYYY-Www>/batch.md`.
4. El agente evalúa: lee `batch.md` y para cada ficha escribe un objeto en `data/batches/<YYYY-Www>/scoring.json`. Usa la rúbrica indicada en el fichero y navega a los repos mediante `/browser` si hace falta.
5. Ejecutar `pnpm spf collect-batch --week <YYYY-Www>` para validar el `scoring.json`. Si hay errores, corregirlos y repetir este paso.
6. Ejecutar `pnpm spf publish --week <YYYY-Www>` para escribir los informes en el vault (Proton Drive) y actualizar el catálogo.
7. Ejecutar `pnpm spf interests sync` de nuevo por si se modificó algo, y realizar commit y push de la evaluación.
