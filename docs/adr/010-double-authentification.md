# ADR 010 — Double authentification (TOTP) et changements de sécurité

- Statut : accepté
- Date : 2026-11-15
- Tâche : MVP, auth étape 3b (complète les ADR 008 et 009)

## Contexte

Un compte d'agence donne accès aux comptes sociaux de plusieurs clients. Un mot de passe volé ou réutilisé
suffisait jusqu'ici. La double authentification par application (TOTP, RFC 6238) est la protection
attendue, et elle ne coûte rien : pas de SMS ni de fournisseur.

## Décision

1. **Plugin `twoFactor` de Better Auth 1.7.15**, limité au TOTP et aux codes de secours. Pas d'OTP par
   courriel ou SMS : il ne protège pas d'une boîte courriel compromise. Les valeurs ci-dessous ont été
   vérifiées dans le code installé.
2. **Stockage** : table `auth.two_factors` (une ligne par utilisateur, `UNIQUE (user_id)`) et colonne
   `auth.users.two_factor_enabled`, accessibles au seul rôle `app_auth` (test `rls-coverage`). La clé TOTP et
   les 10 codes de secours sont **chiffrés** avec `BETTER_AUTH_SECRET` (testé : la base ne contient ni la
   clé ni les codes tels que l'utilisateur les voit).
3. **Activation** : mot de passe exigé, puis QR code et clé à saisir, puis **un premier code valide**.
   Tant que ce code n'est pas validé, rien ne change à la connexion. Les codes de secours ne sont
   affichés qu'une fois (téléchargeables en .txt) ; les régénérer demande le mot de passe et rend les
   anciens inutilisables.
4. **Connexion** : après le bon mot de passe, Better Auth **supprime** la session tout juste créée et pose
   un cookie signé de 10 minutes, valable seulement pour l'étape « code ». Avec ce seul cookie, `/me` et
   toute route d'organisation répondent 401 (testé). Garde-fous intégrés au plugin :
   - 3 requêtes par 10 s sur `/two-factor/*` (quand la limite de débit est active) ;
   - un nombre limité d'essais par défi, au-delà duquel il faut recommencer avec le mot de passe ;
   - un verrouillage temporaire du compte après des échecs répétés ;
   - chaque code de secours ne sert qu'une fois.
5. **« Faire confiance à cet appareil »** : 30 jours, par un cookie signé lié à une valeur de vérification
   renouvelée à chaque usage. Il ne vaut que pour ce navigateur (testé).
6. **Avis par courriel** (hook `after`) après un changement de mot de passe et après la désactivation de
   la 2FA, au cas où la session ne serait pas celle du titulaire. Le changement de mot de passe ferme
   toujours les autres sessions (`revokeOtherSessions`).
7. **QR code dessiné dans le navigateur** avec `uqr` 0.1.3 (nouvelle dépendance web : aucune dépendance,
   types inclus, rendu SVG, MIT ; préférée à `qrcode`, non maintenu depuis 2024, qui entraîne `yargs` et
   `pngjs`). La clé ne part vers aucun service tiers. Le SVG est affiché en `<img src="data:…">`, sans
   injection de HTML.
8. **Page Sécurité** (`/settings/security`) : 2FA (activer, désactiver, régénérer les codes) et
   changement de mot de passe. Elle concerne la personne, pas une organisation : ses appels ne portent
   pas `x-organization-id`. `/me` expose `twoFactorEnabled`.

## Conséquences

- **Changer `BETTER_AUTH_SECRET` rend illisibles toutes les clés TOTP et tous les codes de secours.** Une
  rotation de ce secret demandera une migration (déchiffrer avec l'ancien, rechiffrer avec le nouveau)
  ou une réactivation de la 2FA par chaque utilisateur. À traiter dans le runbook avant la production.
- La 2FA est un choix de chaque utilisateur. L'imposer par organisation (réglage « 2FA obligatoire pour
  les membres ») viendra avec la gestion des membres.
- Les passkeys (étape 3c) seront une autre façon de se connecter, qui vaut à elle seule une double
  authentification.
- Si un utilisateur perd son téléphone et ses codes de secours, il n'y a pas encore de procédure de
  récupération par le support. Elle devra vérifier l'identité hors ligne et sera journalisée.
