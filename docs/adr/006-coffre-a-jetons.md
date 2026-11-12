# ADR 006 — Coffre à jetons OAuth : l'API scelle, seul le worker ouvre

- Statut : accepté
- Date : 2026-11-12
- Tâche : phase 0, 0.9 (partie a)

## Contexte

Règle 3 : jamais de jeton OAuth en clair (base, logs, erreurs, IA, frontend). CLAUDE.md section 6 demande un
chiffrement AES-256-GCM par enveloppe (clé de données par organisation, clé maître hors base, identifiant du
compte en données associées), avec déchiffrement **seulement dans le worker**.

Avec une enveloppe purement symétrique, l'API qui reçoit le jeton (rappel OAuth) doit connaître la clé pour
chiffrer, donc pourrait aussi déchiffrer : la règle « seulement dans le worker » ne serait qu'une convention.

## Décision

Enveloppe à **clé publique** (« sealed box »), uniquement avec `node:crypto` :
X25519 (clé éphémère) → HKDF-SHA256 → AES-256-GCM, avec données associées et un « usage » mêlé à la dérivation.

| Niveau                   | Où                                                                                                      | Rôle                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Paire **maître**         | publique : API (`VAULT_MASTER_PUBLIC_KEY`) ; privée(s) : worker seulement (`VAULT_MASTER_PRIVATE_KEYS`) | Scelle les clés privées d'organisation                                                                       |
| Paire **d'organisation** | `organization_keys` : publique en clair, privée scellée par la clé maître                               | Clé de données par organisation                                                                              |
| **Jetons**               | `oauth_credentials.sealed_tokens`                                                                       | Scellés avec la clé publique de l'organisation ; données associées = `organization_id` + `social_account_id` |

- `@app/vault/seal` (API) ne contient aucune clé privée ; `@app/vault/open` (worker) les possède.
  Une règle ESLint interdit `@app/vault/open` dans `apps/api`, et tout `@app/vault` / `@app/db` dans `apps/web`.
- Type `Secret` : `reveal()` explicite ; `[REDACTED]` dans `JSON.stringify` (donc pino), les chaînes,
  `util.inspect` et les messages d'erreur. Les erreurs du coffre ne contiennent jamais de matériel secret.
- La paire d'organisation est créée au premier jeton stocké (insertion idempotente, une seule par organisation).

## Conséquences

- Une API compromise ne peut pas lire les jetons stockés.
- **Effacement cryptographique** : supprimer la clé d'une organisation rend tous ses jetons irrécupérables
  (et supprime les lignes en cascade).
- **Rotation de la clé maître** : générer une nouvelle paire (`pnpm vault:keygen`), donner la nouvelle clé
  publique à l'API, ajouter la nouvelle clé privée au worker en gardant l'ancienne, puis re-sceller les clés
  privées d'organisation (tâche à écrire) avant de retirer l'ancienne. Les jetons n'ont pas à être re-scellés.
- Format versionné (octet de version) : un changement d'algorithme reste possible.
- En production, les clés privées maîtres viennent d'un gestionnaire de secrets, jamais d'un fichier versionné.
