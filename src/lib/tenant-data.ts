import type { SupabaseClient } from '@supabase/supabase-js';

/** Falhas de qualquer parte do contexto precisam ser visíveis e recuperáveis. */
export async function loadTenantInfo(client: SupabaseClient, overview: () => Promise<any>, tenantId: string) {
  const [tenant, branding, subscription] = await Promise.all([
    client.from('tenants').select('id, slug, name, timezone, status').eq('id', tenantId).single(),
    client.from('tenant_branding').select('*').eq('tenant_id', tenantId).maybeSingle(),
    overview(),
  ]);
  if (tenant.error || !tenant.data) throw new Error('Condomínio indisponível.');
  if (branding.error) throw new Error('Não foi possível carregar a marca do condomínio.');
  return { tenant: tenant.data, branding: branding.data, overview: subscription };
}
