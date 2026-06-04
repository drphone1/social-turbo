'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Globe, RefreshCw, ShieldCheck, ShieldOff, WifiOff } from 'lucide-react';

type WidgetStatus = 'healthy' | 'degraded' | 'offline';

type WidgetResponse = {
  status: WidgetStatus;
  checkedAt: string;
  freshnessMinutes: number;
  latestProbe: {
    host: string;
    status: 'online' | 'offline' | 'unknown';
    latency: number;
  };
  current: {
    latency: number;
    uptime: number;
    packetLoss: number;
    sampleCount: number;
  };
  windows: Record<'1m' | '5m' | '10m', {
    sampleCount: number;
    onlineChecks: number;
    offlineChecks: number;
    uptime: number;
    avgLatency: number;
    packetLoss: number;
  }>;
  trend: Array<{
    label: string;
    latency: number;
    status: 'online' | 'offline' | 'unknown';
    sampleCount: number;
    checkedAt: string;
  }>;
  identity: {
    ip: string | null;
    country: string | null;
    countryCode: string | null;
    city: string | null;
    region: string | null;
    isp: string | null;
    source: string;
    routeMode: 'tunneled' | 'local' | 'unknown';
  };
};

const statusStyles: Record<WidgetStatus, { dot: string; ring: string; text: string; chart: string }> = {
  healthy: {
    dot: 'bg-emerald-400',
    ring: 'shadow-[0_0_0_4px_rgba(16,185,129,0.12)]',
    text: 'text-emerald-200',
    chart: '#34d399',
  },
  degraded: {
    dot: 'bg-amber-400',
    ring: 'shadow-[0_0_0_4px_rgba(251,191,36,0.12)]',
    text: 'text-amber-100',
    chart: '#fbbf24',
  },
  offline: {
    dot: 'bg-rose-400',
    ring: 'shadow-[0_0_0_4px_rgba(244,63,94,0.12)]',
    text: 'text-rose-100',
    chart: '#fb7185',
  },
};

function formatFreshness(minutes: number) {
  if (minutes < 1) {
    return 'now';
  }

  if (minutes < 60) {
    return `${Math.round(minutes)}m ago`;
  }

  return `${(minutes / 60).toFixed(1)}h ago`;
}

function buildSparklinePath(points: WidgetResponse['trend'], width: number, height: number) {
  if (points.length === 0) {
    return '';
  }

  const usableValues = points.map((point) => point.latency);
  const maxValue = Math.max(...usableValues, 1);
  const minValue = Math.min(...usableValues, 0);
  const range = Math.max(maxValue - minValue, 1);

  return points
    .map((point, index) => {
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height - ((point.latency - minValue) / range) * height;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function resolveRouteLabel(routeMode: WidgetResponse['identity']['routeMode']) {
  if (routeMode === 'tunneled') {
    return 'VPN route likely';
  }

  if (routeMode === 'local') {
    return 'Local route likely';
  }

  return 'Route unknown';
}

async function fetchWidgetData(refresh = false) {
  const response = await fetch(`/api/network/connection-widget${refresh ? '?refresh=1' : ''}`);
  if (!response.ok) {
    throw new Error('Failed to fetch connection widget data');
  }

  return response.json() as Promise<WidgetResponse>;
}

export function ConnectionHealthWidget() {
  const queryClient = useQueryClient();
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['connection-widget'],
    queryFn: () => fetchWidgetData(false),
    refetchInterval: 45000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => fetchWidgetData(true),
    onSuccess: (payload) => {
      queryClient.setQueryData(['connection-widget'], payload);
    },
  });

  if (isLoading && !data) {
    return (
      <div className="hidden h-14 w-full max-w-[980px] rounded-[28px] border border-white/10 bg-[#101827]/80 px-5 py-3 backdrop-blur-md lg:flex lg:items-center xl:max-w-[1040px]">
        <div className="animate-pulse flex w-full items-center gap-3">
          <div className="h-6 w-28 rounded bg-white/10" />
          <div className="h-8 flex-1 rounded bg-white/5" />
          <div className="h-8 w-36 rounded bg-white/5" />
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const palette = statusStyles[data.status];
  const sparklineWidth = 112;
  const sparklineHeight = 24;
  const sparklinePath = buildSparklinePath(data.trend, sparklineWidth, sparklineHeight);
  const statusLabel = data.status === 'healthy' ? 'Stable' : data.status === 'degraded' ? 'Unstable' : 'Critical';
  const routeLabel = resolveRouteLabel(data.identity.routeMode);

  return (
    <Link
      href="/network-status"
      className="group hidden h-14 min-w-0 flex-1 max-w-[980px] items-center overflow-hidden rounded-[28px] border border-white/10 bg-[linear-gradient(135deg,rgba(15,23,42,0.96),rgba(17,24,39,0.9))] px-3 py-3 transition-colors hover:border-white/20 lg:flex xl:max-w-[1040px]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
        <div className="flex shrink-0 items-center gap-2.5 border-r border-white/10 pr-3">
          <span className={`h-3.5 w-3.5 rounded-full border border-white/35 ${palette.dot} ${palette.ring}`} />
          <div className="flex flex-col leading-none">
            <span className="text-[10px] uppercase tracking-[0.22em] text-slate-400">Route</span>
            <span className={`mt-1 text-sm font-semibold ${palette.text}`}>{statusLabel}</span>
          </div>
        </div>

        <div className="flex min-w-[174px] shrink-0 items-center gap-2 border-r border-white/10 pr-3 text-sm text-slate-300">
          <Activity className="h-4 w-4 shrink-0 text-slate-300" />
          <span className="font-semibold text-slate-100">{Math.round(data.current.latency)}ms</span>
          <span className="max-w-[56px] truncate text-slate-400">{data.latestProbe.host}</span>
          <span className="shrink-0 text-[11px] text-slate-500">{formatFreshness(data.freshnessMinutes)}</span>
        </div>

        <div className="flex min-w-[206px] shrink-0 items-center gap-2 border-r border-white/10 pr-3 text-sm text-slate-300">
          <Globe className="h-4 w-4 shrink-0 text-sky-300" />
          <span className="shrink-0 text-slate-400">IP</span>
          <span className="w-[96px] shrink-0 font-mono text-[12px] font-semibold text-slate-100">{data.identity.ip || 'unavailable'}</span>
          <span className="truncate text-slate-400">{data.identity.country || 'Unknown'}</span>
        </div>

        <div className="flex min-w-0 max-w-[104px] shrink-0 items-center gap-1 border-r border-white/10 pr-3 text-[10px] text-slate-300">
          {data.identity.routeMode === 'tunneled' ? (
            <ShieldCheck className="h-4 w-4 text-emerald-300" />
          ) : data.identity.routeMode === 'local' ? (
            <ShieldOff className="h-4 w-4 text-amber-300" />
          ) : (
            <WifiOff className="h-4 w-4 text-rose-300" />
          )}
          <span className="truncate uppercase tracking-[0.14em] text-slate-300">{routeLabel}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1 border-r border-white/10 pr-3 text-[10px] text-slate-300">
          {(['1m', '5m', '10m'] as const).map((windowKey) => (
            <div key={windowKey} className="rounded-full bg-white/5 px-1.5 py-1 leading-none">
              <span className="text-slate-500">{windowKey}</span>
              <span className="ml-1 font-semibold text-slate-100">{Math.round(data.windows[windowKey].avgLatency)}</span>
            </div>
          ))}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 pr-0.5">
          <div className="rounded-full bg-white/5 px-1.5 py-1">
            <svg width="112" height="24" viewBox="0 0 112 24" className="overflow-visible">
              <path d={sparklinePath} fill="none" stroke={palette.chart} strokeWidth="2.1" strokeLinecap="round" />
              {data.trend.map((point, index) => {
                const x = data.trend.length === 1 ? sparklineWidth / 2 : (index / (data.trend.length - 1)) * sparklineWidth;
                const values = data.trend.map((item) => item.latency);
                const maxValue = Math.max(...values, 1);
                const minValue = Math.min(...values, 0);
                const range = Math.max(maxValue - minValue, 1);
                const y = sparklineHeight - ((point.latency - minValue) / range) * sparklineHeight;
                const fill = point.status === 'offline' ? '#fb7185' : point.status === 'online' ? palette.chart : '#64748b';
                return <circle key={`${point.label}-${index}`} cx={x} cy={y} r="1.8" fill={fill} />;
              })}
            </svg>
          </div>

          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              refreshMutation.mutate();
            }}
            className="shrink-0 rounded-full border border-white/10 p-2.5 text-slate-300 transition-colors hover:border-white/20 hover:text-slate-100"
            aria-label="Refresh connection status"
          >
            <RefreshCw className={`h-4 w-4 ${(refreshMutation.isPending || isFetching) ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex lg:hidden min-w-0 flex-1 items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
        <span className={`h-3.5 w-3.5 rounded-full border border-white/35 ${palette.dot} ${palette.ring}`} />
            <Activity className="h-4 w-4" />
            <span className={`text-sm font-semibold ${palette.text}`}>{statusLabel}</span>
            <span className="text-sm text-slate-300">{Math.round(data.current.latency)}ms</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-slate-400">{data.identity.country || 'Unknown'}</span>
          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              refreshMutation.mutate();
            }}
            className="rounded-full border border-white/10 p-2.5 text-slate-300 transition-colors hover:border-white/20 hover:text-slate-100"
            aria-label="Refresh connection status"
          >
            <RefreshCw className={`h-4 w-4 ${(refreshMutation.isPending || isFetching) ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
    </Link>
  );
}