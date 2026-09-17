import type { ActivateFrontend, MessageProps } from '@cockpit/module-api';
import { identity, keyId, snapshotKeys } from '../shared/protocol.ts';
import type { MessageKey, Snapshot } from '../shared/protocol.ts';
import { DeviceBridge } from './device.ts';
import { bell } from './icons.ts';
import { UnreadStore } from './store.ts';
import type { UnreadState } from './store.ts';
import { observeRead } from './visibility.ts';

const labels: Record<UnreadState['status'], string> = {
  empty: '未同步', refreshing: '同步中', ready: '已同步', stale: '同步失败',
  suspended: '后台暂停', disconnected: '连接已断开', stopped: '模块已停用',
};

export const activate: ActivateFrontend = context => {
  if (context.apiVersion !== 2 || context.uiVersion !== 1 || !context.state?.host ||
      typeof context.state.register !== 'function' || !context.onInvalidate || typeof context.createPortal !== 'function') {
    throw new Error('未读通知需要宿主 Module frontend v2 / UI v1、state、onInvalidate 和 createPortal');
  }
  const React = context.react;
  const deviceState = context.state.register({
    id: 'device-bridge',
    create: () => new DeviceBridge(context),
    dispose: device => device.dispose(),
  });
  const unreadState = context.state.register({
    id: 'unread-store',
    create: () => new UnreadStore({
      request: context.request, report: context.report,
      apply: (state, acknowledged) => deviceState.get().apply(state, acknowledged),
    }),
    dispose: store => store.dispose(),
  });
  const device = deviceState.get();
  const store = unreadState.get();
  let stopped = false;
  let modalOpen = false;
  let foreground = false;
  let indexed: Snapshot | null = null;
  let keys = new Map<string, MessageKey>();
  const unread = (state: Snapshot | null, key: MessageKey) => {
    if (state !== indexed) { indexed = state; keys = state ? snapshotKeys(state) : new Map(); }
    return keys.has(keyId(key));
  };
  const useUnread = () => React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const updateActivity = () => {
    const view = context.state.host.getSnapshot();
    const activity = { ...view, visible: view.visible && document.visibilityState === 'visible',
      connected: view.connected && navigator.onLine !== false };
    store.setActivity(activity);
    const next = activity.visible && activity.connected;
    if (next && !foreground) void device.refreshWorker();
    foreground = next;
  };
  const onMessage = (event: MessageEvent) => { if (device.handleMessage(event)) store.refresh(); };
  const unsubscribeView = context.state.host.subscribe(updateActivity);
  const unsubscribeInvalidate = context.onInvalidate(store.refresh);
  document.addEventListener('visibilitychange', updateActivity);
  window.addEventListener('online', updateActivity);
  window.addEventListener('offline', updateActivity);
  navigator.serviceWorker?.addEventListener('message', onMessage);
  updateActivity();
  void device.bootstrap();

  function useMarker(props: MessageProps) {
    const state = useUnread();
    const message = props.identity;
    const key: MessageKey = { sessionId: message.sessionId, kind: message.kind === 'ask' ? 'ask' : 'reply', nativeId: message.id };
    const id = keyId(key);
    const generation = state.snapshot?.generation ?? null;
    const transition = React.useRef({ id, complete: props.complete, fresh: false, generation });
    if (transition.current.id !== id) transition.current = { id, complete: props.complete, fresh: false, generation };
    if (transition.current.generation && generation && transition.current.generation !== generation) {
      transition.current = { id, complete: props.complete, fresh: false, generation };
    }
    if (!transition.current.complete && props.complete) transition.current.fresh = true;
    transition.current.complete = props.complete;
    if (!transition.current.generation) transition.current.generation = generation;
    const root = !message.agentId && (message.kind === 'ask' || message.role === 'assistant');
    const valid = root && props.complete && identity(message.sessionId) && identity(message.id);
    const known = valid && unread(state.snapshot, key);
    const eligible = valid && (known || transition.current.fresh || message.kind === 'ask');
    const [element, setElement] = React.useState<HTMLDivElement | null>(null);
    const bodyRef = React.useCallback((node: HTMLDivElement | null) => {
      setElement(node);
      if (typeof props.bodyRef === 'function') {
        const cleanup = props.bodyRef(node);
        if (typeof cleanup === 'function') return () => { setElement(null); cleanup(); };
      } else if (props.bodyRef) props.bodyRef.current = node;
    }, [props.bodyRef]);
    const [height, setHeight] = React.useState<number | null>(null);
    React.useLayoutEffect(() => {
      if (!known || !element) { setHeight(null); return; }
      const measure = () => setHeight(element.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }, [id, known, element]);
    React.useEffect(() => {
      if (!eligible || !element || !generation || !store.canPresent()) return;
      return observeRead(element,
        () => !stopped && !modalOpen && store.canPresent() && context.state.host.getSnapshot().sessionId === message.sessionId &&
          store.getSnapshot().snapshot?.generation === generation,
        () => store.present(key, generation), 600);
    }, [id, eligible, element, generation, state.status]);
    const marker = known ? <span className="cn-redline" role="img" aria-label={message.kind === 'ask' ? '未读提问' : '未读消息'}
      style={{ margin: 0, ...(height === null ? {} : { height, bottom: 'auto' }) }} /> : null;
    return { bodyRef, marker };
  }

  function SessionBadge({ sessionId }: { sessionId: string }) {
    const state = useUnread();
    const count = state.snapshot?.sessions.find(session => session.sessionId === sessionId)?.count;
    if (!count) return null;
    const stale = state.status !== 'ready' && state.status !== 'refreshing';
    return <span className={`cn-session-badge${stale ? ' cn-stale' : ''}`}
      aria-label={`${count} 条未读${stale ? '，尚未同步' : ''}`} title={stale ? labels[state.status] : undefined}>{count}</span>;
  }

  function Settings({ close }: { close(): void }) {
    const state = useUnread();
    const status = React.useSyncExternalStore(device.subscribe, device.getSnapshot, device.getSnapshot);
    const dialog = React.useRef<HTMLDialogElement>(null);
    const heading = React.useId();
    React.useEffect(() => {
      modalOpen = true;
      const element = dialog.current;
      element?.showModal();
      return () => {
        modalOpen = false;
        element?.close();
      };
    }, []);
    const permission = { default: '尚未询问', granted: '已允许', denied: '已拒绝', unsupported: '不支持' }[status.permission];
    return context.createPortal(<dialog ref={dialog} className="cn-dialog" aria-labelledby={heading}
      onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="cn-settings">
        <header><h2 id={heading}>未读与系统通知</h2><button className="ck-button" type="button" onClick={close} aria-label="关闭通知设置">关闭</button></header>
        <p role="status">未读：{state.snapshot ? state.snapshot.total : '未知'} · {labels[state.status]}
          {state.pending > 0 ? ` · ${state.pending} 条阅读待确认` : ''}</p>
        {state.error && <p className="cn-error" role="alert">{state.error}</p>}
        <p>未读仅记录模块本次运行中新到达的主 Agent 最终回复和待处理提问。模块重启会清空未读，不回补历史。</p>
        <p>前台完整看到短消息或长消息末尾，稳定 600 毫秒后确认阅读；不会自动回答提问。推送通常延迟约
          {Number(context.config.pushDelayMs ?? 3000) / 1000} 秒，快速阅读可能取消尚未发送的提醒。</p>
        <p>系统权限：{permission}。本设备：{status.registered ? '已登记推送' : status.subscribed ? '浏览器已订阅，服务端未确认登记' : '未启用推送'}。</p>
        {!status.supported && <p>当前浏览器、非安全连接或宿主不支持 Web Push；网页未读仍可使用。iPhone/iPad 可能需要先添加到主屏幕。</p>}
        {status.needsResubscribe && <p>推送公钥已改变（或浏览器无法确认旧公钥），请明确点击重新订阅。</p>}
        {status.updatePending && <p role="status">通知后台程序更新等待激活。可稍后重新同步，必要时重新加载页面；不会接管聊天页面。
          <button className="ck-button" type="button" onClick={() => window.location.reload()}>重新加载页面</button></p>}
        {status.badgeSupported === false && <p>此平台未提供应用角标 API；系统通知和网页未读独立工作。</p>}
        {status.error && <p className="cn-error" role="alert">{status.error}</p>}
        <p>其他设备已读不会静默唤醒本设备；下次成功同步才清理旧提醒。系统可能重复或短暂显示迟到通知。
          关闭或点击系统通知本身不标记已读。</p>
        <footer>
          <button className="ck-button" type="button" disabled={status.busy} onClick={() => { store.refresh(); void device.sync(); }}>重新同步</button>
          <button className="ck-button" type="button" disabled={!status.supported || status.busy || (status.registered && !status.needsResubscribe)}
            onClick={() => { void device.enable().then(() => store.refresh()); }}>
            {status.busy ? '处理中…' : status.needsResubscribe ? '重新订阅此设备' : '启用此设备通知'}
          </button>
          {status.subscribed && <button className="ck-button" type="button" disabled={status.busy} onClick={() => { void device.disable(); }}>停用此设备推送</button>}
        </footer>
      </section>
    </dialog>, document.body);
  }
  function GlobalAction() {
    const state = useUnread();
    const status = React.useSyncExternalStore(device.subscribe, device.getSnapshot, device.getSnapshot);
    const [open, setOpen] = React.useState(false);
    const uncertain = state.status !== 'ready' || status.updatePending;
    const total = state.snapshot?.total;
    const label = `通知设置，${total === undefined ? '未读未同步' : `${total} 条未读`}，${labels[state.status]}${status.updatePending ? '，后台程序更新待激活' : ''}`;
    return <>
      <button type="button" className={`ck-button cn-global${uncertain ? ' cn-stale' : ''}`}
        aria-label={label} title={label} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <svg className="ck-icon ck-icon-md" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {bell.map(([tag, attributes], index) => React.createElement(tag, { ...attributes, key: index }))}
        </svg>
        <span>{total ?? '—'}</span>{uncertain && <span className="cn-state-dot" aria-hidden="true" />}
      </button>
      {open && <Settings close={() => setOpen(false)} />}
    </>;
  }
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    unsubscribeView();
    unsubscribeInvalidate();
    document.removeEventListener('visibilitychange', updateActivity);
    window.removeEventListener('online', updateActivity);
    window.removeEventListener('offline', updateActivity);
    navigator.serviceWorker?.removeEventListener('message', onMessage);
    context.signal.removeEventListener('abort', dispose);
  };
  context.signal.addEventListener('abort', dispose, { once: true });
  if (context.signal.aborted) dispose();
  return {
    apiVersion: 2,
    components: [
      { id: 'unread-marker', boundary: 'message', wrap: Base => function UnreadMessage(props) {
        const { bodyRef, marker } = useMarker(props);
        return <Base {...props} bodyRef={bodyRef} adornment={marker ? <>{props.adornment}{marker}</> : props.adornment} />;
      } },
      { id: 'unread-count', boundary: 'sessionStatus', wrap: Base => function UnreadSessionStatus(props) {
        return <Base {...props}>{props.children}<SessionBadge sessionId={props.sessionId} /></Base>;
      } },
      { id: 'notification-navigation', boundary: 'globalNavigation', wrap: Base => function NotificationNavigation(props) {
        return <Base {...props}>{props.children}<GlobalAction /></Base>;
      } },
      { id: 'notification-management', boundary: 'managementHeader', wrap: Base => function NotificationManagement(props) {
        return <Base {...props} actions={<><GlobalAction />{props.actions}</>} />;
      } },
      { id: 'notification-detail', boundary: 'managementDetailHeader', wrap: Base => function NotificationDetail(props) {
        return <Base {...props} actions={<><GlobalAction />{props.actions}</>} />;
      } },
    ],
    dispose,
  };
};
