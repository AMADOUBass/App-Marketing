# ADR 002 — NestJS 12 en ESM, logs et OpenTelemetry

- Statut : accepté
- Date : 2026-11-08
- Tâche : phase 0, 0.3

## Contexte

CLAUDE.md prévoit NestJS 11. NestJS 12 est sorti le 2026-08-27 (12.4.0 au 8 nov. 2026) ; la 11.2 reste
maintenue. Les paquets NestJS 12 sont ESM uniquement. Notre config TypeScript (`@app/config`) est déjà ESM
(`module: NodeNext`, `verbatimModuleSyntax`).

NestJS 12 propose aussi `@nestjs/observe`, un SDK d'observabilité intégré.

## Décision

1. **NestJS 12.4 + adaptateur Fastify**, application en ESM (`"type": "module"`).
   Compilation par SWC via `@nestjs/cli` (`builder: swc`) ; `tsc --noEmit` pour la vérification de types.
   Tests : Vitest 5 + `unplugin-swc` (nécessaire pour les métadonnées de décorateurs).
2. **Pas de `@nestjs/observe`** : c'est un service hébergé payant (licence propriétaire, collecteur unique
   `observe-api.nestjs.com`). Contraire à « sans dépendance à un cloud précis » et à OpenTelemetry.
3. **OpenTelemetry minimal**, activé seulement si `OTEL_EXPORTER_OTLP_ENDPOINT` est défini :
   `@opentelemetry/sdk-node` + instrumentations `http` et `pino` (pas `auto-instrumentations-node`, qui
   installe plus d'une centaine de paquets). Chargé avant l'app par `node --import ./dist/instrumentation.js`.
   En ESM, OpenTelemetry exige son hook de chargement `@opentelemetry/instrumentation/hook.mjs`, enregistré
   avec `module.register()`.
4. **Logs** : nestjs-pino, JSON. Les logs de requête sont une liste blanche (id, méthode, chemin sans query
   string, code de statut) : pas d'en-têtes, pas d'IP, pas de query string. Les en-têtes sensibles sont en plus
   masqués par `redact` (défense en profondeur). L'identifiant de requête vient de Fastify (`x-request-id`
   entrant s'il est sûr, sinon UUID) et est renvoyé dans la réponse.
5. **Erreurs** : filtre global RFC 9457 (`application/problem+json`) ; les 5xx ne renvoient jamais le message
   interne ; la query string n'est jamais renvoyée.

## Conséquences

- Imports relatifs avec extension `.js` dans le code TypeScript (règle ESM).
- Dépendances circulaires entre providers : utiliser `forwardRef` + un type enveloppe (`WrapperType<T>`),
  comme le documente NestJS pour ESM.
- Node 26 affiche `DEP0205: module.register() is deprecated` quand OpenTelemetry est activé. OpenTelemetry ne
  documente pas encore `module.registerHooks()` (même si `import-in-the-middle` 3.6 le prend en charge).
  À revoir quand OpenTelemetry le supportera officiellement.
- Le worker (0.7) réutilisera la même config (NestJS 12, ESM, `instrumentation.ts`).
