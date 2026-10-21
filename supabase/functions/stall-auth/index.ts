// Stall owner / helper login with phone + 4-digit PIN (no SMS, no OTP).
// POST {action: 'login', fair, phone, pin}  or  {action: 'join', fair, code, stall, owner, phone, pin}
// → {access_token, refresh_token, must_change, kind, joined?}  — the app passes the tokens to supabase.auth.setSession().
//
// PIN check + lockout live in SQL (pin_check / join_stall). This function only turns a passed check into a real
// Supabase Auth session: one auth user per stall/helper (user id = stall id / helper id), claims in app_metadata.
// Deploy: supabase functions deploy stall-auth --no-verify-jwt
import { createClient } from 'npm:@supabase/supabase-js@2';

const url = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const b = await req.json();
    const { data: who, error } = b.action === 'join'
      ? await admin.rpc('join_stall', { p_fair: b.fair, p_code: b.code, p_stall: b.stall, p_owner: b.owner, p_phone: b.phone, p_pin: b.pin })
      : await admin.rpc('pin_check', { p_fair: b.fair, p_phone: b.phone, p_pin: String(b.pin ?? '') });
    if (error) return reply(500, { error: error.message });
    if (who.error) return reply(401, { error: who.error });

    // Identifies the auth user; nothing is ever sent to it (no confirmation mail, the link is used right here).
    // Supabase Auth rejects some made-up domains, so use plus-addresses on a real inbox: STAFF_EMAIL=you@gmail.com
    const [local, domain] = (Deno.env.get('STAFF_EMAIL') || 'staff@stallday.invalid').split('@');
    const email = `${local}+${who.kind}-${who.id}@${domain}`;
    const app_metadata = { app_role: who.kind, fair_id: who.fair_id, stall_id: who.stall_id, helper_id: who.kind === 'helper' ? who.id : null };
    const created = await admin.auth.admin.createUser({ id: who.id, email, email_confirm: true, app_metadata });
    if (created.error) {
      const upd = await admin.auth.admin.updateUserById(who.id, { email, email_confirm: true, app_metadata });   // exists → refresh claims
      if (upd.error) return reply(500, { error: upd.error.message });
    }
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (link.error) return reply(500, { error: link.error.message });
    const { data, error: vErr } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.data.properties.hashed_token });
    if (vErr || !data.session) return reply(500, { error: vErr?.message || 'no session' });

    return reply(200, { access_token: data.session.access_token, refresh_token: data.session.refresh_token, kind: who.kind, must_change: who.must_change, joined: !!who.joined });
  } catch (e) {
    return reply(400, { error: String(e) });
  }
});
