# ADR 011 — Passkeys (WebAuthn)

- Statut : accepté
- Date : 2026-11-16
- Tâche : MVP, auth étape 3c (complète les ADR 008 à 010)

## Contexte

Les passkeys permettent de se connecter avec l'appareil (Touch ID, Face ID, Windows Hello, téléphone),
sans mot de passe à retenir ni à se faire voler. Elles résistent à l'hameçonnage : une passkey est liée au
domaine et ne répond pas sur un faux site. Better Auth les fournit par un paquet officiel séparé.

## Décision

1. **`@better-auth/passkey` 1.7.15**, même version que Better Auth, publiée le 2026-11-01. Il apporte
   `@simplewebauthn/server` 13.3.3. Côté web : **`@simplewebauthn/browser` 13.3.0**, sans dépendance, même
   branche majeure que le serveur, pour le dialogue WebAuthn du navigateur. Deux dépendances ajoutées.
2. **Table `auth.passkeys`** : clés **publiques** seulement (la clé privée ne quitte jamais l'appareil),
   `credential_id` unique, compteur de signatures (un compteur qui recule révèle un authentificateur
   cloné). Accessible au seul rôle `app_auth` (test `rls-coverage`).
3. Trois réglages par défaut du plugin, relevés dans son code, sont **durcis** :
   - **Vérification de l'utilisateur exigée.** Le plugin vérifie les signatures WebAuthn avec
     `requireUserVerification: false`, écrit en dur : une simple pression sur une clé de sécurité, sans
     PIN ni biométrie, ouvrirait une session et contournerait la 2FA. Nous demandons
     `userVerification: 'required'` à l'enregistrement, et les hooks `afterVerification` (enregistrement
     et connexion) refusent toute réponse sans le drapeau UV : code `USER_VERIFICATION_REQUIRED`, testé.
     Ainsi, une passkey vaut un mot de passe et un second facteur, et la connexion par passkey ne repasse
     pas par l'étape TOTP.
   - **Origine fixée.** Sans réglage, le plugin prend comme origine attendue l'en-tête `Origin` de la
     requête. `origin` et `rpID` viennent maintenant de `BETTER_AUTH_URL`. Une réponse signée pour une
     autre origine est refusée (testé).
   - **Session récente pour ajouter une passkey.** Une passkey donne un accès durable au compte : une
     session volée ou restée ouverte ne doit pas suffire. Un hook `before` refuse l'ajout si la session a
     plus de 10 minutes (`SESSION_NOT_FRESH`) ; la page propose de se reconnecter. Nous n'utilisons pas
     `session.freshAge`, qui changerait d'autres routes de Better Auth.
4. **Passkeys découvrables** (`residentKey: 'required'`) : la connexion se fait sans saisir d'adresse,
   par le bouton « Se connecter avec une passkey » ou par la suggestion automatique du navigateur dans le
   champ courriel (`autocomplete="username webauthn"`).
5. **Avis par courriel** à l'ajout et à la suppression d'une passkey (hook `after`, comme dans
   l'ADR 010).
6. **Jetons de session absents du JSON, correction élargie.** La réponse de connexion par passkey, comme
   `/api/auth/get-session` exposée depuis l'ADR 008, contient `session.token`. Le filtre de
   `auth-routes.ts` ne retirait que `token` au premier niveau ; il retire maintenant aussi `session.token`
   (testé sur les deux routes).
7. Les applications Nest (api, worker) ne génèrent plus de fichiers `.d.ts` (`packages/config`,
   `nest.json`) : personne ne les importe, et les types du plugin passkey ne pouvaient pas être nommés.

## Tests

`apps/api/test/webauthn.ts` est un **authentificateur logiciel** (P-256, données d'authentificateur, CBOR,
signature) écrit avec `node:crypto`. Les tests d'API enregistrent et se connectent comme le ferait un
navigateur, et vérifient les refus :

- pas de vérification de l'utilisateur ;
- autre origine ;
- clé inconnue ;
- passkey supprimée ;
- session trop ancienne.

Côté web, `@simplewebauthn/browser` est simulé dans les tests unitaires. Les E2E vérifient les pages
avec axe.

## Conséquences

- **Les passkeys refusent les adresses IP** : en développement, ouvrir `http://localhost:5173`, pas
  `127.0.0.1`. Le tunnel (`pnpm tunnel`) a un autre nom d'hôte que `BETTER_AUTH_URL`, donc pas de
  passkey par le tunnel.
- En production, `rpID` sera le domaine de l'application. Changer ce domaine rendrait les passkeys
  existantes inutilisables : il faudra choisir le domaine définitif avant d'ouvrir les inscriptions.
- La 2FA par TOTP reste disponible pour les appareils sans passkey.
