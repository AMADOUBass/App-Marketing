# ADR 004 — Rester sur TypeScript 6 en attendant l'outillage TypeScript 7

- Statut : accepté
- Date : 2026-11-11
- Tâche : phase 0, 0.6

## Contexte

TypeScript 7.0 (compilateur natif) est sorti (7.0.2 au 11 nov. 2026). CLAUDE.md demandait de vérifier s'il
fonctionne avec les décorateurs NestJS avant de l'adopter.

## Essai (TS 7.0.2 installé à part, sans toucher au projet)

| Vérification                                                                               | Résultat                                                                                            |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `tsc --noEmit` sur api, db, contracts, config avec nos tsconfig stricts                    | 0 erreur, comme TS 6.0.3                                                                            |
| Détection d'erreurs (type faux, `noUncheckedIndexedAccess`) dans une classe NestJS décorée | Mêmes erreurs que TS 6                                                                              |
| Émission `experimentalDecorators` + `emitDecoratorMetadata`                                | OK, y compris `design:paramtypes: [ProbeService]` (injection par constructeur)                      |
| Durée de vérification de `apps/api`                                                        | 1,2 s (TS 7) contre 4,1 s (TS 6)                                                                    |
| typescript-eslint 8.72 (latest et canary)                                                  | **Incompatible** : exige `typescript <6.1` (il a besoin de l'API programmatique, absente de TS 7.0) |
| `@nestjs/cli` 12.0.12                                                                      | Embarque `typescript ~6.0.2`                                                                        |

## Décision

Rester sur **TypeScript 6.0.3** partout (vérification de types, lint, CLI Nest). L'émission reste faite par SWC.

Pas de configuration hybride (TS 7 pour `typecheck`, TS 6 pour le lint) : les deux paquets s'appellent
`typescript` et exposent le même binaire `tsc`, ce qui oblige à des alias fragiles, et le gain (environ
3 s par package) ne le justifie pas à notre taille.

## Conséquences

- Notre code et nos tsconfig sont déjà compatibles TS 7 : la migration sera un changement de version.
- À réévaluer quand **typescript-eslint** acceptera TS 7 (attendu avec l'API de TS 7.1) et que le CLI Nest
  le suivra. Refaire l'essai :
  ```bash
  npm install --no-save --ignore-scripts typescript@7  # dans un dossier temporaire
  <dossier>/node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.json
  ```
