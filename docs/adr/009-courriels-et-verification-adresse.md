# ADR 009 — Courriels transactionnels et vérification d'adresse obligatoire

- Statut : accepté
- Date : 2026-11-13
- Tâche : MVP, auth étape 3a (complète l'ADR 008)

## Contexte

La connexion (ADR 008) ne vérifiait pas l'adresse courriel. Trois conséquences :

- n'importe qui pouvait créer un compte au nom d'une autre adresse ;
- l'inscription révélait qu'un compte existait (« adresse déjà utilisée ») ;
- sans courriel, pas de « mot de passe oublié ».

Les invitations et les validations client à venir reposent elles aussi sur une adresse fiable.

## Décision

1. **Vérification obligatoire** (`requireEmailVerification`) : aucune session avant d'avoir ouvert le lien
   reçu, valable 24 h. Ouvrir ce lien vérifie l'adresse et ouvre la session (`autoSignInAfterVerification`).
   Une connexion avec le bon mot de passe sur une adresse non vérifiée renvoie un nouveau lien.
2. **Réponses neutres**, vérifiées dans le code de Better Auth 1.7.15 et testées :
   - avec la vérification obligatoire, l'inscription répond **pareil** que l'adresse ait un compte ou non
     (même statut, même forme, mot de passe haché dans les deux cas pour égaliser le temps). Le vrai
     titulaire reçoit un courriel « tentative de création de compte » (`onExistingUserSignUp`) ;
   - « mot de passe oublié » répond pareil pour une adresse inconnue et n'envoie rien dans ce cas.
3. **Envoi sans attendre** : sans gestionnaire de tâches de fond, Better Auth attend la fin de l'envoi avant
   de répondre, et le temps de réponse trahirait l'existence du compte. `advanced.backgroundTasks` lance
   l'envoi sans le faire attendre. Un échec est journalisé sans le lien ni l'adresse.
4. **Réinitialisation** : lien valable 1 h, à usage unique. Le changement de mot de passe ferme **toutes**
   les sessions (`revokeSessionsOnPasswordReset`) et le titulaire reçoit un courriel « mot de passe modifié ».
   La page web retire le jeton de la barre d'adresse dès son arrivée.
5. **Jetons hachés en base** : `verification.storeIdentifier: 'hashed'`. Par défaut, Better Auth stocke le
   jeton de réinitialisation **en clair** dans `auth.verifications`, si bien qu'une fuite de la base donnerait
   des liens valides ; ce n'est plus le cas (testé).
6. **Contenu des courriels** : aucun texte saisi à l'inscription (le nom), car n'importe qui peut s'inscrire
   avec l'adresse d'un autre et ce texte finirait dans la boîte de la victime. Langue : `Accept-Language`
   du navigateur à l'origine de l'envoi (FR par défaut). Texte et HTML, avec échappement.
7. **Transport** : SMTP via `nodemailer` 10.3.1 (dépendance ajoutée : client SMTP de référence, types
   inclus). `SMTP_URL` est obligatoire et traitée comme un secret (`Secret`, car elle peut contenir des
   identifiants) ; `MAIL_FROM` a une valeur par défaut.
   - Développement : **Mailpit** (`axllent/mailpit:v1.32.0`) dans `docker-compose.dev.yml` capture tout,
     boîte sur http://localhost:8025. Rien ne quitte la machine.
   - Production : le SMTP d'un fournisseur, avec une offre gratuite au départ (règle d'hébergement de
     CLAUDE.md). Le choix et la configuration SPF, DKIM et DMARC du domaine viendront au déploiement.
   - Tests : un faux service d'envoi capture les messages ; les tests suivent les liens comme un
     utilisateur.
8. **Limites** : 3 envois par minute et par IP pour `/send-verification-email` et
   `/request-password-reset`, ce qui empêche d'inonder une boîte (testé).

## Conséquences

- Les comptes déjà créés en local sans vérification doivent ouvrir le lien envoyé à leur prochaine
  connexion. Le compte de démo (`pnpm db:seed`) est marqué vérifié.
- L'envoi se fait dans le processus api. Si le volume ou les reprises l'exigent (fournisseur indisponible),
  il passera par l'outbox et le worker. Les liens d'authentification expirent vite : il faudra alors veiller
  à ne pas garder de jeton en clair dans Valkey.
- Better Auth stocke encore les jetons de **session** en clair dans `auth.sessions`, sans option de hachage
  à ce jour. Le cookie est signé, mais une fuite de la base permettrait de réutiliser une session
  jusqu'à son expiration. C'est noté pour un ADR futur (rotation, durée de vie courte).
