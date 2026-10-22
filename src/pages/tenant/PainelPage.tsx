import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Download, Package, PackageCheck, Tablet, UserCheck } from 'lucide-react';
import { rpc } from '../../lib/api';
import { useTenant } from '../../lib/tenant';
import { navigate, onLink, query } from '../../lib/router';
import { dateTime, download, STATUS_LABEL, toCsv, unitName } from '../../lib/format';
import { listAllPackages, listPackages, PackageRow } from '../../lib/packages';
import { Alert, Button, Card, Empty, Field, Input, Select, Spinner, toast } from '../../components/ui';

const ymd = (tz: string, delta = 0) => new Date(Date.now() + delta * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
const n = (v: unknown) => Number(v || 0).toLocaleString('pt-BR');

function Kpi({ label, value, hint, href, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: 'warning' | 'danger' }) {
  const body = (
    <>
      <p className="text-xs text-muted">{label}</p>
      <p className={`text-3xl font-semibold mt-1 tabular-nums ${tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : ''}`}>{value}</p>
      {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
    </>
  );
  return href
    ? <a href={href} onClick={onLink} className="block rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent">{body}</a>
    : <Card>{body}</Card>;
}

/** Variação sem base (anterior = 0) aparece como texto, nunca como infinito. */
function Change({ value, previous, change }: { value: number; previous: number; change: number | null }) {
  if (change === null) return <span>{previous === 0 && value > 0 ? 'Sem base de comparação' : 'Igual ao período anterior'}</span>;
  const up = change > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return <span className="inline-flex items-center gap-1">{change === 0 ? 'Igual' : <><Icon className="w-3 h-3" aria-hidden />{Math.abs(change * 100).toFixed(0)}%</>} vs. período anterior ({n(previous)})</span>;
}

export function PainelPage() {
  const [tab, setTab] = useState<'operacao' | 'analise'>(() => {
    const q = query('aba'); if (q === 'analise' || q === 'operacao') return q;
    try { return (localStorage.getItem('pp_dash_tab') as any) || 'operacao'; } catch { return 'operacao'; }
  });
  const pick = (v: 'operacao' | 'analise') => { setTab(v); try { localStorage.setItem('pp_dash_tab', v); } catch { /* ok */ } };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Visão geral</h1>
        <div role="tablist" className="inline-flex rounded-xl border border-line bg-surface p-1" data-tour="painel-abas">
          {(['operacao', 'analise'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={tab === v} onClick={() => pick(v)}
              className={`px-4 min-h-10 rounded-lg text-sm font-medium ${tab === v ? 'bg-primary text-primary-fg' : 'text-text hover:bg-surface-2'}`}>{v === 'operacao' ? 'Operação' : 'Análise'}</button>
          ))}
        </div>
      </div>
      {tab === 'operacao' ? <Operation /> : <Analysis />}
    </div>
  );
}

function Operation() {
  const t = useTenant();
  const base = `/c/${t.tenant.slug}`;
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => rpc('dashboard_operation', { p_tenant: t.tenant.id }).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [t.tenant.id]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <Alert tone="danger">{error} <button className="underline" onClick={load}>Tentar novamente</button></Alert>;
  if (!d) return <Spinner />;
  const a = d.attention;
  const occ = d.occupancy;
  const pct = occ.capacity ? Math.round((occ.used / occ.capacity) * 100) : null;
  // Prioridade: ação que bloqueia pessoas > risco físico > comunicação > administrativo.
  const items: [number, string, string, string][] = ([
    [a.access_requests, 'Solicitações de cadastro aguardando aprovação', 'Revisar', `${base}/pessoas?aba=solicitacoes`],
    [a.stale_packages, `Encomendas aguardando há mais de ${d.stale_hours} h`, 'Ver lista', `${base}/relatorios?status=PENDENTES&antigas=1`],
    [a.near_capacity, 'Locais de guarda com 85% ou mais de ocupação', 'Ver locais', `${base}/configuracoes?m=operacao`],
    [a.notification_failures, 'Avisos com falha final (WhatsApp, e-mail ou push)', 'Diagnóstico', `${base}/configuracoes?m=integracoes`],
    [a.receipt_failures, 'Comprovantes em PDF com falha', 'Diagnóstico', `${base}/configuracoes?m=integracoes`],
    [a.preregistered, 'Pré-registros antigos do totem a conferir', 'Conferir', `${base}/portaria`],
  ] as [number, string, string, string][]).filter(([c]) => c > 0);
  const pend = items.reduce((s, [c]) => s + c, 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-tour="painel-kpis">
        <Kpi label="Aguardando retirada agora" value={n(d.waiting_now)} hint={d.unstored_now ? `${d.unstored_now} sem local de guarda` : 'na portaria'} href={`${base}/relatorios?status=PENDENTES`} />
        <Kpi label={`Acima de ${d.stale_hours} h`} value={n(d.stale_now)} tone={d.stale_now ? 'warning' : undefined} hint="aguardando retirada" href={`${base}/relatorios?status=PENDENTES&antigas=1`} />
        <Kpi label="Ocupação dos locais" value={pct === null ? '—' : `${pct}%`} hint={occ.capacity ? `${n(occ.used)} de ${n(occ.capacity)} vagas` : 'Capacidade não definida'} href={`${base}/configuracoes?m=operacao`} />
        <Kpi label="Pendências que exigem ação" value={n(pend)} tone={pend ? 'danger' : undefined} hint={pend ? `${items.length} tipo(s), detalhados abaixo` : 'nada pendente'} />
      </div>

      <Card className="space-y-2" data-tour="painel-atencao">
        <p className="font-semibold">Precisa de atenção</p>
        {items.length === 0 ? <p className="text-sm text-muted">Nada pendente agora.</p> : (
          <ul className="divide-y divide-line">
            {items.map(([c, label, cta, href]) => (
              <li key={label} className="py-2 flex items-center justify-between gap-3 text-sm">
                <span><strong className="tabular-nums">{n(c)}</strong> · {label}</span>
                <a href={href} onClick={onLink} className="shrink-0 underline min-h-10 inline-flex items-center">{cta}</a>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid lg:grid-cols-3 gap-3">
        <Card className="space-y-3">
          <p className="font-semibold">Hoje</p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-muted text-xs">Recebidas</p><p className="text-2xl font-semibold tabular-nums">{n(d.received_today)}</p></div>
            <div><p className="text-muted text-xs">Retiradas</p><p className="text-2xl font-semibold tabular-nums">{n(d.picked_today)}</p></div>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {t.isStaff && <Button variant="secondary" onClick={() => navigate(`${base}/portaria`)}><Package className="w-4 h-4" /> Receber</Button>}
            {t.isStaff && <Button variant="secondary" onClick={() => navigate(`${base}/portaria?aba=entregar`)}><PackageCheck className="w-4 h-4" /> Entregar</Button>}
            {t.can('approve') && a.access_requests > 0 && <Button variant="secondary" onClick={() => navigate(`${base}/pessoas?aba=solicitacoes`)}><UserCheck className="w-4 h-4" /> Aprovar cadastros</Button>}
            {t.isStaff && <Button variant="ghost" onClick={() => navigate(`${base}/totem-equipe`)}><Tablet className="w-4 h-4" /> Abrir totem</Button>}
          </div>
        </Card>
        <Card className="lg:col-span-2" data-tour="painel-ocupacao">
          <p className="font-semibold mb-3">Ocupação por local</p>
          {d.locations.length === 0 ? <Empty title="Nenhum local de guarda">Cadastre estantes em Configurações › Operação e armazenamento.</Empty> : (
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
              {d.locations.slice(0, 10).map((o: any) => {
                const p = Math.round((o.used / o.capacity) * 100);
                return (
                  <li key={o.id}>
                    <div className="flex justify-between text-sm gap-2"><span className="truncate">{[o.rack, o.shelf].filter(Boolean).join(' › ') || o.code}{o.is_contingency ? ' (contingência)' : ''}</span><span className="tabular-nums shrink-0">{o.used}/{o.capacity}</span></div>
                    <div className="h-2 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={`Ocupação ${o.code}: ${p}%`}>
                      <div className={`h-full ${p >= 100 ? 'bg-danger' : p >= 85 ? 'bg-warning' : 'bg-secondary'}`} style={{ width: `${Math.min(p, 100)}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-2"><p className="font-semibold">Atividade recente</p><a href={`${base}/relatorios`} onClick={onLink} className="text-sm underline">Histórico completo</a></div>
        {d.recent.length === 0 ? <p className="text-sm text-muted">Nenhuma movimentação ainda.</p> : (
          <ul className="divide-y divide-line text-sm">
            {d.recent.map((r: any) => (
              <li key={r.id + r.kind} className="py-2 flex justify-between gap-2"><span className="truncate">{r.kind === 'picked' ? 'Retirada' : 'Recebida'} · {r.unit || '—'} · {r.carrier}</span><span className="text-muted shrink-0">{dateTime(r.at, t.tenant.timezone)}</span></li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-muted">Valores calculados no servidor, no fuso {d.timezone}. Atualizado em {dateTime(d.as_of, t.tenant.timezone)}.</p>
    </div>
  );
}

const DOW = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const CH: Record<string, string> = { whatsapp: 'WhatsApp', email: 'E-mail', push: 'Push' };
const STATE: Record<string, string> = { pending: 'Pendente', accepted: 'Aceito pelo provedor', delivered: 'Entregue (confirmado)', failed_retryable: 'Falha (vai tentar de novo)', failed_final: 'Falha final', disabled: 'Desativado/sem canal' };

function Analysis() {
  const t = useTenant();
  const tz = t.tenant.timezone;
  const [range, setRange] = useState<'1' | '7' | '30' | 'custom'>('30');
  const [from, setFrom] = useState(ymd(tz, -29));
  const [to, setTo] = useState(ymd(tz));
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (range !== 'custom') { setFrom(ymd(tz, -(Number(range) - 1))); setTo(ymd(tz)); } }, [range, tz]);
  useEffect(() => {
    setD(null);
    rpc('dashboard_analysis', { p_tenant: t.tenant.id, p_from: from, p_to: to }).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message));
  }, [t.tenant.id, from, to]);
  const maxDay = useMemo(() => Math.max(1, ...(d?.daily || []).map((x: any) => Math.max(x.in, x.out))), [d]);
  const heat = useMemo(() => {
    const m = new Map<string, number>(); let max = 0;
    for (const h of d?.heatmap || []) { m.set(`${h.dow}-${h.hour}`, h.n); max = Math.max(max, h.n); }
    return { m, max };
  }, [d]);
  const peak = useMemo(() => (d?.heatmap || []).reduce((a: any, b: any) => (!a || b.n > a.n ? b : a), null), [d]);
  const totalCarrier = (d?.carriers || []).reduce((s: number, c: any) => s + c.n, 0);

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3" data-tour="painel-filtros">
        <div role="radiogroup" aria-label="Período" className="inline-flex rounded-xl border border-line p-1">
          {([['1', 'Hoje'], ['7', '7 dias'], ['30', '30 dias'], ['custom', 'Personalizado']] as const).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={range === v} onClick={() => setRange(v)} className={`px-3 min-h-10 rounded-lg text-sm ${range === v ? 'bg-surface-2 font-semibold' : ''}`}>{l}</button>
          ))}
        </div>
        {range === 'custom' && <>
          <Field label="De"><Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Até"><Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        </>}
      </Card>
      {error ? <Alert tone="danger">{error}</Alert> : !d ? <Spinner /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Entradas no período" value={n(d.entries.value)} hint={<Change {...d.entries} />} />
            <Kpi label="Retiradas no período" value={n(d.pickups.value)} hint={<Change {...d.pickups} />} />
            <Kpi label="Tempo até retirada (mediana)" value={d.dwell.n ? `${d.dwell.median_h} h` : '—'}
              hint={d.dwell.n ? `média ${d.dwell.avg_h} h${d.dwell.p90_h != null ? ` · 90% até ${d.dwell.p90_h} h` : ''} · ${d.dwell.n} retiradas` : 'Sem retiradas no período'} />
            <Kpi label="Adesão dos moradores" value={d.adoption.units_active ? `${Math.round(d.adoption.units_with_resident / d.adoption.units_active * 100)}%` : '—'}
              hint={`${d.adoption.units_with_resident} de ${d.adoption.units_active} unidades com morador aprovado${d.adoption.pending_requests ? ` · ${d.adoption.pending_requests} pendente(s)` : ''}`} />
          </div>

          <Card>
            <p className="font-semibold">Entradas e retiradas por dia</p>
            <p className="text-xs text-muted mb-3"><span className="inline-block w-3 h-3 rounded-sm bg-secondary align-middle mr-1" />Entradas <span className="inline-block w-3 h-3 rounded-sm bg-accent align-middle ml-3 mr-1" />Retiradas</p>
            {d.daily.every((x: any) => !x.in && !x.out) ? <p className="text-sm text-muted">Sem movimentação no período.</p> : (
              <div className="flex items-end gap-1 h-40 overflow-x-auto" role="img" aria-label={`Gráfico de ${d.days} dias; tabela abaixo`}>
                {d.daily.map((x: any) => (
                  <div key={x.day} className="flex-1 min-w-[10px] flex items-end gap-px h-full" title={`${x.day}: ${x.in} entradas, ${x.out} retiradas`}>
                    <div className="flex-1 bg-secondary rounded-t" style={{ height: `${(x.in / maxDay) * 100}%` }} />
                    <div className="flex-1 bg-accent rounded-t" style={{ height: `${(x.out / maxDay) * 100}%` }} />
                  </div>
                ))}
              </div>
            )}
            <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted">Ver tabela</summary>
              <div className="max-h-60 overflow-y-auto"><table className="w-full mt-2"><thead className="text-left text-muted"><tr><th className="font-medium">Dia</th><th className="font-medium">Entradas</th><th className="font-medium">Retiradas</th></tr></thead>
                <tbody>{d.daily.map((x: any) => <tr key={x.day}><td>{new Date(`${x.day}T12:00:00`).toLocaleDateString('pt-BR')}</td><td className="tabular-nums">{x.in}</td><td className="tabular-nums">{x.out}</td></tr>)}</tbody></table></div>
            </details>
          </Card>

          <div className="grid lg:grid-cols-2 gap-3">
            <Card>
              <p className="font-semibold mb-2">Aguardando agora, por tempo</p>
              <ul className="space-y-1 text-sm">
                {([['lt24', 'Até 24 h'], ['h24_48', '24–48 h'], ['h48_72', '48–72 h'], ['gt72', 'Mais de 72 h']] as const).map(([k, l]) => (
                  <li key={k} className="flex justify-between"><span>{l}</span><span className={`tabular-nums ${k === 'gt72' && d.aging_now[k] ? 'text-warning font-semibold' : ''}`}>{n(d.aging_now[k])}</span></li>
                ))}
              </ul>
            </Card>
            <Card>
              <p className="font-semibold mb-2">Transportadoras</p>
              {totalCarrier === 0 ? <p className="text-sm text-muted">Sem entradas no período.</p> : (
                <ul className="space-y-1 text-sm">{d.carriers.map((c: any) => <li key={c.carrier} className="flex justify-between gap-2"><span>{c.carrier}</span><span className="tabular-nums">{n(c.n)} · {Math.round(c.n / totalCarrier * 100)}%</span></li>)}</ul>
              )}
            </Card>
          </div>

          <Card>
            <p className="font-semibold">Quando as encomendas chegam</p>
            {!peak ? <p className="text-sm text-muted">Sem entradas no período.</p> : <>
              <p className="text-sm text-muted mb-3">Maior concentração: {DOW[peak.dow - 1]} entre {peak.hour}h e {peak.hour + 1}h ({peak.n} {peak.n === 1 ? 'entrada' : 'entradas'}). Considere reforçar a portaria nesse horário.</p>
              <div className="overflow-x-auto"><table className="text-[10px]" aria-label="Entradas por dia da semana e hora">
                <thead><tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="font-normal text-muted w-5">{h % 3 === 0 ? h : ''}</th>)}</tr></thead>
                <tbody>{DOW.map((w, i) => <tr key={w}><th className="font-normal text-muted pr-1 text-left">{w}</th>
                  {Array.from({ length: 24 }, (_, h) => { const v = heat.m.get(`${i + 1}-${h}`) || 0; return <td key={h} title={`${w} ${h}h: ${v}`} className="w-5 h-5 rounded-sm" style={{ background: v ? `color-mix(in srgb, var(--c-secondary) ${20 + 80 * v / heat.max}%, transparent)` : 'var(--c-surface-2, #eee)' }} />; })}</tr>)}</tbody>
              </table></div>
            </>}
          </Card>

          <div className="grid lg:grid-cols-2 gap-3">
            <Card>
              <p className="font-semibold mb-2">Exceções no período</p>
              {d.exceptions.length === 0 ? <p className="text-sm text-muted">Nenhuma devolução, cancelamento ou extravio registrado.</p>
                : <ul className="space-y-1 text-sm">{d.exceptions.map((e: any) => <li key={e.status} className="flex justify-between"><span>{STATUS_LABEL[e.status]}</span><span className="tabular-nums">{n(e.n)}</span></li>)}</ul>}
            </Card>
            <Card>
              <p className="font-semibold mb-2">Comunicações por canal</p>
              {d.channels.length === 0 ? <p className="text-sm text-muted">Nenhum aviso no período.</p> : (
                <table className="w-full text-sm"><tbody>{d.channels.sort((a: any, b: any) => a.channel.localeCompare(b.channel)).map((c: any) => (
                  <tr key={c.channel + c.state}><td>{CH[c.channel] || c.channel}</td><td className="text-muted">{STATE[c.state] || c.state}</td><td className="text-right tabular-nums">{n(c.n)}</td></tr>))}</tbody></table>
              )}
              <p className="text-xs text-muted mt-2">“Aceito pelo provedor” não significa que o morador leu.</p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/** Relatórios: lista completa com filtros e exportação CSV (mesmos filtros). */
export function RelatoriosPage() {
  const t = useTenant();
  const tz = t.tenant.timezone;
  const oldOnly = query('antigas') === '1';
  const [from, setFrom] = useState(oldOnly ? '' : ymd(tz, -29));
  // “Antigas”: corta no servidor até 3 dias atrás; o corte exato de 72 h é aplicado na lista.
  const [to, setTo] = useState(oldOnly ? ymd(tz, -3) : ymd(tz));
  const [status, setStatus] = useState(query('status') || '');
  const [rows, setRows] = useState<PackageRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const cutoff = Date.now() - 72 * 3600_000;
  const filt = (r: PackageRow[]) => (oldOnly ? r.filter((p) => new Date(p.received_at).getTime() <= cutoff) : r);
  const params = { status: status || null, from: from || null, to: to || null };
  const load = async () => {
    setError(null); setRows(null);
    try { const r = await listPackages(t.tenant.id, { ...params, limit: 50 }); setRows(filt(r)); setMore(r.length === 50); }
    catch (e: any) { setError(e.message); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to, status, t.tenant.id]);
  const loadMore = async () => {
    const last = rows![rows!.length - 1];
    const r = await listPackages(t.tenant.id, { ...params, limit: 50 }, { at: last.received_at, id: last.id });
    setRows([...rows!, ...filt(r)]); setMore(r.length === 50);
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = filt(await listAllPackages(t.tenant.id, params));
      download(`encomendas-${t.tenant.slug}-${from || 'inicio'}-a-${to || 'hoje'}.csv`, toCsv(all.map((p) => ({
        ...p, unit: unitName(p.unit_block, p.unit_label), status_label: STATUS_LABEL[p.status], received: dateTime(p.received_at, tz), picked: dateTime(p.picked_up_at, tz),
      })), [['unit', 'Unidade'], ['carrier', 'Transportadora'], ['tracking_code', 'Rastreio'], ['recipient_name', 'Destinatário'], ['status_label', 'Situação'],
        ['received', 'Recebida em'], ['storage_code', 'Local'], ['picked', 'Retirada em'], ['picked_up_by_name', 'Retirada por'], ['pickup_method', 'Validação'], ['resolution_reason', 'Motivo da exceção']]));
    } catch (e: any) { toast.error(e.message); } finally { setExporting(false); }
  };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Relatórios</h1>
      {oldOnly && <Alert tone="info">Mostrando encomendas aguardando há mais de 72 h. <a className="underline" href={`/c/${t.tenant.slug}/relatorios`} onClick={onLink}>Limpar filtro</a></Alert>}
      <Card className="grid sm:grid-cols-4 gap-3 items-end" data-tour="painel-exportar">
        <Field label="De"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Até"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Situação">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todas</option><option value="PENDENTES">Pendentes</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Button variant="secondary" onClick={exportCsv} loading={exporting}><Download className="w-4 h-4" /> Exportar CSV</Button>
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card>
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty title="Nenhuma encomenda com esses filtros" /> : (
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-left text-muted"><tr><th className="py-2 px-4 sm:pl-0 font-medium">Unidade</th><th className="pr-3 font-medium">Transportadora</th><th className="pr-3 font-medium">Recebida</th><th className="pr-3 font-medium">Situação</th><th className="font-medium">Retirada por</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((p) => (
                  <tr key={p.id}><td className="py-2 px-4 sm:pl-0">{unitName(p.unit_block, p.unit_label)}</td><td className="pr-3">{p.carrier}</td><td className="pr-3 whitespace-nowrap">{dateTime(p.received_at, tz)}</td><td className="pr-3">{STATUS_LABEL[p.status]}</td><td>{p.picked_up_by_name || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more && <Button variant="ghost" className="mt-2" onClick={loadMore}>Carregar mais</Button>}
      </Card>
    </div>
  );
}
