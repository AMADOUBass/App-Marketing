// Fixed demo data for local development (pnpm db:seed). Never used in production.

export const DEMO_ORGANIZATIONS = [
  {
    id: '0195f000-0000-7000-8000-00000000000a',
    name: 'Agence Démo A',
    workspaceId: '0195f000-0000-7000-8000-0000000000a1',
    workspaceName: 'Boulangerie du Plateau',
    posts: [
      'Nouveau croissant aux amandes dès samedi 🥐',
      'Horaires des fêtes : ouvert le 24 jusqu’à 16 h.',
      'Merci à nos 10 000 abonnés ! Concours en story cette semaine.',
    ],
  },
  {
    id: '0195f000-0000-7000-8000-00000000000b',
    name: 'Agence Démo B',
    workspaceId: '0195f000-0000-7000-8000-0000000000b1',
    workspaceName: 'Café Laurier',
    posts: ['Our winter menu is here: maple latte is back.'],
  },
] as const;

/** Signs in on the web after `pnpm db:seed`; owner of every demo organization. Local only. */
export const DEMO_USER = {
  name: 'Démo Ponctua',
  email: 'demo@ponctua.local',
  password: 'demo-ponctua-local',
} as const;
