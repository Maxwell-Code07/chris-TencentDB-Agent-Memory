import { type CSSProperties } from 'react';
import { type MemoryLayer, type MemoryBlock, type AtomicItem, type LayerTone } from './types';
import { LAYERS, PROSE_CLASS } from './constants';
import { getLayerCount, stripAtMention, extractRole, formatDisplayTime } from './utils';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppIcon, UsergroupIcon } from 'tea-icons-react';

const LAYER_TONE_STYLE: Record<LayerTone, CSSProperties> = {
  default: {
    background: 'var(--tea-color-bg-secondary-default)',
    borderColor: 'var(--tea-color-border-primary-default)',
    color: 'var(--tea-color-text-primary)',
  },
  brand: {
    background: 'var(--tea-color-bg-brand-lighten-default)',
    borderColor: 'var(--tea-color-border-brand-default)',
    color: 'var(--tea-color-text-brand-default)',
  },
  success: {
    background: 'var(--tea-color-bg-success-lighten-default)',
    borderColor: 'var(--tea-color-border-success-default)',
    color: 'var(--tea-color-text-success-default)',
  },
  warning: {
    background: 'var(--tea-color-bg-warning-lighten-default)',
    borderColor: 'var(--tea-color-border-warning-default)',
    color: 'var(--tea-color-text-warning-default)',
  },
};

const ROLE_STYLE: Record<'user' | 'system' | 'assistant', CSSProperties> = {
  user: LAYER_TONE_STYLE.brand,
  system: LAYER_TONE_STYLE.warning,
  assistant: LAYER_TONE_STYLE.success,
};

export function BlockDetail({
  block,
  layer,
  onLayerChange,
  agentLabel,
  layerPage,
  layerPageSize,
  layerLoading,
  onLayerPageChange,
  onLayerItemLoad,
  layerItemLoadingId,
}: {
  block: MemoryBlock;
  layer: MemoryLayer;
  onLayerChange: (l: MemoryLayer) => void;
  agentLabel: (id?: string) => string;
  layerPage: number;
  layerPageSize: number;
  layerLoading: boolean;
  onLayerPageChange: (page: number) => void;
  onLayerItemLoad?: (itemId: string) => void;
  layerItemLoadingId?: string | null;
}) {
  const total = getLayerCount(block, layer);
  const pageCount = Math.max(1, Math.ceil(total / layerPageSize));
  const showPager = (layer === 'L0' || layer === 'L1') && total > layerPageSize;
  const safePage = Math.min(layerPage, pageCount - 1);

  return (
    <>
      {/* Block meta */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-foreground/85 break-all">{block.title}</div>
          <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {block.agent_id ? (
              <span className="px-1.5 py-0.5 rounded border font-mono text-[10px] inline-flex items-center gap-0.5" style={LAYER_TONE_STYLE.success}>
                <AppIcon size={12} /> 固定到 {agentLabel(block.agent_id)}
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded border text-[10px] inline-flex items-center gap-0.5" style={LAYER_TONE_STYLE.warning}>
                <UsergroupIcon size={12} /> 团队记忆池
              </span>
            )}
            {block.uploaded_by_user_id && (
              <>
                <span>上传：<span className="font-mono">@{block.uploaded_by_user_id}</span></span>
                <span>·</span>
              </>
            )}
            <span>更新：{new Date(block.updated_at_ms).toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* L0–L3 tabs */}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
        {LAYERS.map((l) => {
          const active = l.id === layer;
          // 该层计数是否「已知」：后端给了真实值、或用户已切到该层加载过（layerCounts 写回），
          // 或本地已有条目。未知的层（还没访问过）显示占位「·」而非误导性的 0，
          // 提示用户点击后才按需加载真实计数。
          const loadedLen = l.id === 'L0' ? block.layers.L0.length : block.layers[l.id].length;
          const known = block.layerCounts[l.id] !== undefined || loadedLen > 0;
          const cnt = getLayerCount(block, l.id);
          return (
            <button
              key={l.id}
              onClick={() => onLayerChange(l.id)}
              className={[
                'rounded-xl border px-3 py-2 text-left transition',
                active ? '' : 'border-border bg-card hover:bg-accent'
              ].join(' ')}
              style={active ? { ...LAYER_TONE_STYLE[l.tone], boxShadow: 'var(--tea-shadow-sm)' } : undefined}
            >
              <div className="flex items-center justify-between">
                <span className={`text-[12px] font-semibold ${active ? '' : 'text-foreground/70'}`}>{l.label}</span>
                <span
                  className={`text-[11px] font-mono ${active ? '' : 'text-muted-foreground'}`}
                  title={known ? undefined : '点击加载该层内容'}
                >
                  {known ? cnt : '·'}
                </span>
              </div>
              <div className={`text-[10px] mt-0.5 ${active ? 'opacity-90' : 'text-muted-foreground'}`}>{l.desc}</div>
            </button>
          );
        })}
      </div>

      {/* Layer content */}
      <div className="mt-4">
        {layerLoading ? (
          // 加载态：骨架占位替换旧内容 —— 否则切换层 / 翻页 / 切换记忆块时，上一次的
          // 条目会残留在屏幕上直到新数据返回，视觉上就是"闪一下旧内容"。
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 rounded-lg border border-border bg-muted/50 animate-pulse" />
            ))}
          </div>
        ) : layer === 'L0' ? (
          block.layers.L0.length > 0 ? (
            <div className="space-y-0">
              {block.layers.L0.map((msg, idx) => {
                const role = extractRole(msg.role || msg.title || '');
                const cleanBody = stripAtMention(msg.body);
                const isUser = role === 'user';
                const isSystem = role === 'system';
                const roleTone = isUser ? 'user' : isSystem ? 'system' : 'assistant';
                const time = formatDisplayTime(msg.created_at);
                return (
                  <div
                    key={msg.id || idx}
                    className="flex px-3 py-2.5"
                    style={{
                      background: ROLE_STYLE[roleTone].background,
                      borderBottom: idx !== block.layers.L0.length - 1 ? '1px solid var(--tea-color-border-secondary-default)' : undefined,
                    }}
                  >
                    <span
                      className="shrink-0 w-16 text-[10px] font-semibold leading-5 select-none"
                      style={{ color: ROLE_STYLE[roleTone].color }}
                    >
                      {role.toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <pre className="text-[12px] whitespace-pre-wrap break-all leading-relaxed font-sans m-0" style={{ color: 'var(--tea-color-text-paragraph)' }}>
                        {cleanBody}
                      </pre>
                      {time && (
                        <div className="mt-1 text-[10px] font-mono select-none" style={{ color: 'var(--tea-color-text-tertiary)' }} title={msg.created_at}>
                          {time}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-[12px] px-2 py-6 text-center" style={{ color: 'var(--tea-color-text-tertiary)' }}>该记忆块未保留 L0 对话原文。</div>
          )
        ) : (
          <AtomicList
            layer={layer}
            items={block.layers[layer]}
            onLoadItem={onLayerItemLoad}
            loadingItemId={layerItemLoadingId}
          />
        )}
        {showPager && (
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-[11px] text-muted-foreground">
            <span>
              第 {safePage + 1} / {pageCount} 页 · 当前 {block.layers[layer].length} 条 / 共 {total} 条
            </span>
            <div className="flex items-center gap-1">
              <button
                className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={layerLoading || safePage <= 0}
                onClick={() => onLayerPageChange(safePage - 1)}
              >
                上一页
              </button>
              <button
                className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40"
                disabled={layerLoading || safePage >= pageCount - 1}
                onClick={() => onLayerPageChange(safePage + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function AtomicList({
  layer,
  items,
  onLoadItem,
  loadingItemId,
}: {
  layer: MemoryLayer;
  items: AtomicItem[];
  onLoadItem?: (itemId: string) => void;
  loadingItemId?: string | null;
}) {
  const meta = LAYERS.find((l) => l.id === layer)!;
  if (items.length === 0) {
    return (
      <div className="text-[12px] text-muted-foreground px-2 py-4">
        该记忆块在 {meta.short} 层暂无条目。可由 curator / 高层提炼后写入。
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((it) => {
        const isL2 = layer === 'L2';
        const hasBody = it.body.trim().length > 0;
        const loading = loadingItemId === it.id;
        return (
          <li key={it.id} className="rounded-lg border border-border bg-card p-3 hover:bg-accent transition">
            <div className="flex items-start gap-2">
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold" style={LAYER_TONE_STYLE[meta.tone]}>
                {layer}
              </span>
              <div className="min-w-0 flex-1">
                {isL2 ? (
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-foreground/85 hover:text-primary"
                      onClick={() => onLoadItem?.(it.id)}
                      disabled={loading}
                      title={it.title}
                    >
                      {it.title}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => onLoadItem?.(it.id)}
                      disabled={loading}
                    >
                      {loading ? '加载中…' : hasBody ? '收起原文' : '展开原文'}
                    </button>
                  </div>
                ) : (
                  <div className="text-[13px] font-semibold text-foreground/85">{it.title}</div>
                )}
                {layer === 'L2' || layer === 'L3' ? (
                  hasBody ? (
                    <div className={`mt-1 ${PROSE_CLASS}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.body}</ReactMarkdown>
                    </div>
                  ) : isL2 ? null : (
                    <div className="mt-1 text-[12px] text-muted-foreground">暂无原文。</div>
                  )
                ) : (
                  <pre className="mt-1 text-[12px] text-foreground/70 whitespace-pre-wrap font-sans leading-relaxed">{it.body}</pre>
                )}
                <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px] text-muted-foreground">
                  {it.refs?.map((r) => (
                    <span key={r} className="px-1 rounded bg-muted text-foreground/70 font-mono">{r}</span>
                  ))}
                  {it.tags?.map((t) => (
                    <span key={t} className="px-1 rounded bg-muted text-foreground/70">#{t}</span>
                  ))}
                  {(() => {
                    const time = formatDisplayTime(it.created_at);
                    return time ? (
                      <span className="ml-auto font-mono" style={{ color: 'var(--tea-color-text-tertiary)' }} title={it.created_at}>{time}</span>
                    ) : null;
                  })()}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
