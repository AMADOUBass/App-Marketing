# ADR 001 — Socle d'outillage et stockage S3 local

- Statut : accepté
- Date : 2026-11-08
- Tâches : phase 0, 0.1 et 0.2

## Contexte

CLAUDE.md fixe la stack et demande de vérifier la dernière version stable au moment d'installer.
Le 8 nov. 2026, plusieurs points s'écartent du texte initial :

1. Node.js 26 est passé LTS (« Lithium », 26.13.0 publié le 2026-10-28). CLAUDE.md prévoyait d'y passer
   « quand sa promotion LTS est confirmée ».
2. Vitest 5.1 est la version stable (CLAUDE.md citait Vitest 4). ESLint 10 est stable.
3. TypeScript 7.0 est sorti, mais typescript-eslint 8.72 n'accepte que `typescript <6.1`.
4. MinIO n'est plus distribué en image Docker : `minio/minio` et `minio/mc` n'existent plus sur Docker Hub
   et `quay.io/minio/minio:latest` est introuvable.

## Décision

| Sujet             | Choix                                                                                | Raison                                                               |
| ----------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Runtime           | Node.js 26.13.0 (`.nvmrc`, `engines >=26.13.0 <27`, `engineStrict`)                  | LTS confirmé, prévu par CLAUDE.md                                    |
| TypeScript        | 6.0.3                                                                                | Requis par typescript-eslint ; TS 7 sera évalué en 0.6               |
| Lint              | ESLint 10.14 + typescript-eslint 8.72 (`strictTypeChecked` + `stylisticTypeChecked`) | Règles typées (promesses, `any`, etc.) ; pas d'oxlint pour l'instant |
| Format            | Prettier 3.9                                                                         |                                                                      |
| Tests             | Vitest 5.1                                                                           | Dernière stable, compatible Node 26 et Vite 8                        |
| Monorepo          | pnpm 11.1.1 + Turborepo 2.11                                                         |                                                                      |
| Stockage S3 local | RustFS 1.0.4 (Apache 2.0) + `amazon/aws-cli` pour créer le bucket                    | Remplace MinIO, qui n'a plus d'image publiée                         |

Toutes les versions sont épinglées exactement (`pnpm add -E`, tags Docker précis, actions GitHub par SHA).

### Pourquoi RustFS plutôt qu'un autre stockage compatible S3

- Licence Apache 2.0 (Garage est AGPL ; MinIO était AGPL).
- Un seul conteneur, configuration par variables d'environnement, proche de MinIO.
- Le stockage local ne sert qu'à imiter R2 en développement : le code applicatif parle S3 générique
  (endpoint, clés, bucket configurables), donc changer de serveur ne touche pas le code.
- Alternative de repli : SeaweedFS (Apache 2.0, plus ancien, configuration plus lourde).

## Conséquences

- Les postes de dev doivent avoir Node 26 (`nvm install 26.13.0`).
- Le code d'upload doit rester compatible S3 standard (URL signées, multipart, CORS) sans API propre
  à RustFS ni à R2. Les tests d'intégration média tourneront contre RustFS ; une vérification contre R2
  réel sera faite avant la mise en production.
- À réévaluer : passage à TypeScript 7 (tâche 0.6) quand typescript-eslint le supportera ; oxlint si le
  lint devient lent.
