// Serveur de synchro d'ETR BUDGET.
// Il ne stocke que des données CHIFFRÉES par l'appli (il ne peut pas les lire),
// rangées sous un identifiant secret de 64 caractères (empreinte du code de synchro).

const ALLOWED_ORIGINS = [
  'https://elouantanguyrollier-cloud.github.io',
  'http://localhost:8765',
];
const MAX_BYTES = 2 * 1024 * 1024; // 2 Mo
const ID_RE = /^\/v1\/([0-9a-f]{64})$/;

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = { ...cors(origin), 'Content-Type': 'application/json' };
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    const m = ID_RE.exec(new URL(request.url).pathname);
    if (!m) return reply(404, { error: 'not_found' });
    const id = m[1];

    try {
      if (request.method === 'GET') {
        const row = await env.DB.prepare('SELECT rev, data, updated_at AS updatedAt FROM sync WHERE id = ?').bind(id).first();
        if (!row) return reply(404, { error: 'empty' });
        return reply(200, row);
      }

      if (request.method === 'PUT') {
        const text = await request.text();
        if (text.length > MAX_BYTES) return reply(413, { error: 'too_large' });
        let body;
        try { body = JSON.parse(text); } catch { return reply(400, { error: 'bad_json' }); }
        if (typeof body.data !== 'string' || !Number.isInteger(body.rev) || body.rev < 0) return reply(400, { error: 'bad_body' });

        // Écriture atomique : on n'écrase que si l'appareil a vu la dernière version (rev)
        const now = new Date().toISOString();
        // RETURNING : une ligne n'est renvoyée que si l'écriture a vraiment eu lieu
        const written = body.rev === 0
          ? await env.DB.prepare('INSERT INTO sync (id, rev, data, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING rev').bind(id, body.data, now).first()
          : await env.DB.prepare('UPDATE sync SET rev = rev + 1, data = ?, updated_at = ? WHERE id = ? AND rev = ? RETURNING rev').bind(body.data, now, id, body.rev).first();
        if (written) return reply(200, { rev: written.rev });
        const cur = await env.DB.prepare('SELECT rev FROM sync WHERE id = ?').bind(id).first();
        return reply(409, { error: 'conflict', rev: cur ? cur.rev : 0 });
      }
    } catch (e) {
      return reply(503, { error: 'unavailable' });
    }

    return reply(405, { error: 'method_not_allowed' });
  },
};
