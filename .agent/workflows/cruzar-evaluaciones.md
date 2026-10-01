# Cruzar evaluaciones — SkillsPluginFinder

Cruza la evaluación de Claude Code y la de Antigravity de **una semana ya evaluada**: media de los scores, `disputa` si difieren en 3 o más puntos, `confianza alta` si los dos llegan a 7. Si el cruce cambia algo que se publica, vuelve a publicar el informe y a poner al día las filas `candidato` de `Catalogo.md`. Es el paso 8 y 9 de `evaluar-semana` hecho aparte: sirve para repetirlo cuando Antigravity llega tarde, para una semana evaluada antes de que existiera el cruce, o en el reintento de las 12:00.

Semana: `$ARGUMENTS` en Claude Code, o la que indique Stones. Si no hay ninguna, ejecuta `pnpm spf week` (la semana ISO de hoy en Europe/Madrid, en la última línea de la salida). En lo que sigue es `<semana>`.

## Reglas

- **Todo lo que ya está decidido se respeta.** El cruce solo cambia el `score` y la marca de las filas que siguen en `candidato`; una fila `probado`, `adoptado` o `descartado` no se toca.
- **No reevalúes ni edites ningún `scoring*.json`.** Cruzar es una operación determinista sobre las dos evaluaciones tal como están. Si una no valida, el cruce sigue solo con la otra y lo dice: no la arregles a mano.
- **`--force` solo con motivo.** `spf publish --force` regenera el informe desde cero y borra lo que Stones haya anotado a mano en él. Solo se usa si el informe ya está `revisado: true` **y** `spf cross` ha dicho «publicación: cambia» (algún score ≥ umbral es distinto), y antes se guarda una copia del informe actual en `data/logs/`.
- Si un comando falla, lee el error y corrige la causa. Nada de parches con regex ni scripts ad hoc, y no inventes datos ni ficheros para que algo pase.
- No hagas `git push` ni pongas tags. El commit sí; el push lo hace Stones.
- Pega la salida de cada `pnpm spf` en tu resumen final: un paso solo está hecho con la salida que lo prueba.

## Pasos

1. **Comprobar lo que hay.** Debe existir `data/batches/<semana>/scoring.json` (la de Claude Code); si no, para y dilo. `scoring-antigravity.json` puede faltar: el cruce seguirá solo con Claude Code.
2. **Cruzar.** `pnpm spf cross --week <semana>` valida las dos evaluaciones con el esquema de siempre y escribe `data/batches/<semana>/cruce.json`. Lee su salida: cuántas coinciden, las disputas, la confianza alta y la línea `publicación:`.
3. **Publicar solo si cambia.**
   - `publicación: sin cambios` → no publiques; salta al paso 5.
   - `publicación: cambia` → `pnpm spf publish --week <semana>`. Si responde que el informe ya está revisado, copia el informe actual (`Informes/<semana>.md` del vault) a `data/logs/` y repite con `--force`.
4. **Ver lo que ha cambiado.** `pnpm spf review --list` enseña las filas `candidato` con su score ya cruzado; el informe lleva por hallazgo la línea «Evaluación cruzada» y la nota del catálogo empieza por `⚖ disputa …` o `✓ confianza alta …`.
5. **Sincronizar.** `pnpm spf interests sync`, para que `catalog.json` refleje los scores y estados nuevos.
6. **Commit.** `git add data interests.yaml catalog.json` y `git commit -m "feat(evaluate): cruce de la semana <semana>"`. Enseña `git status`. No hagas push: lo hace Stones.
7. **Resumen para Stones.** Nº de coincidencias, de diferencias de 1-2 puntos y de disputas (con su nombre y los dos scores), los hallazgos con confianza alta, qué filas del catálogo cambiaron y la salida de cada comando.

## Cómo se lee el cruce

- **Score final** = media de los dos, con un decimal (`7.5`). Con un solo evaluador, el suyo.
- **`⚖ disputa`**: difieren en 3 o más puntos. Es una señal para mirar a mano: en la revisión automática **bloquea `adoptado`** (queda en `probado`).
- **`✓ confianza alta`**: los dos puntúan 7 o más. Es la mejor señal que da la semana, pero no sustituye a la revisión del repositorio.
- Una fila entra al informe cuando su score final llega al umbral de `Intereses.md`, aunque Claude Code la hubiera dejado por debajo, y sale si baja de él.
