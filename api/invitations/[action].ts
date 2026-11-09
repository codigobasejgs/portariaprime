/**
 * Equipe numa única função (limite de 12 funções do plano Vercel Hobby).
 *   POST /api/invitations/send            -> convite por e-mail (_send.ts)
 *   POST /api/team/create | /api/team/password -> acessos com senha (_team.ts), via rewrite do vercel.json
 *   POST /api/team/porter-{preview,signup,login,photo} -> identidade do porteiro (_porter.ts)
 */
import { handler, HttpError } from '../_lib/http.js';
import { send } from './_send.js';
import { team } from './_team.js';
import { porter } from './_porter.js';

export const POST = handler(async (request) => {
  const u = new URL(request.url);
  // Na Vercel o rewrite manda ?a=; no servidor local o caminho original (/api/team/create).
  const action = u.searchParams.get('a') || u.pathname.replace(/^\/api\/team\//, '/api/invitations/team-').split('/').pop();
  if (action === 'send') return send(request);
  if (action === 'team-create') return team(request, 'create');
  if (action === 'team-password') return team(request, 'password');
  if (action === 'team-resident-reset') return team(request, 'resident-reset');
  if (action?.startsWith('team-porter-')) return porter(request, action.slice(12));
  throw new HttpError(404, 'Ação desconhecida.');
});
