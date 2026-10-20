import type { SupabaseClient } from '@supabase/supabase-js';

/** Inscrição do navegador não comprova inscrição deste usuário neste condomínio. */
export async function hasPushRegistration(client: SupabaseClient, tenantId: string, userId: string, endpoint: string) {
  const { data, error } = await client.from('push_subscriptions').select('id')
    .eq('tenant_id', tenantId).eq('user_id', userId).eq('endpoint', endpoint).maybeSingle();
  if (error) throw new Error('Não foi possível verificar as notificações deste condomínio.');
  return Boolean(data);
}

export async function removePushRegistration(client: SupabaseClient, tenantId: string, userId: string, endpoint: string) {
  const { error } = await client.from('push_subscriptions').delete()
    .eq('tenant_id', tenantId).eq('user_id', userId).eq('endpoint', endpoint);
  if (error) throw new Error('Não foi possível desativar as notificações deste condomínio.');
  // Não cancela PushManager: a mesma inscrição pode atender outro vínculo autorizado.
}
