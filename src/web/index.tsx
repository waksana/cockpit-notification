import type { ActivateFrontend, MessageProps } from '@cockpit/module-api';
import { identity, keyId, snapshotKeys } from '../shared/protocol.ts';
import type { MessageKey, Snapshot } from '../shared/protocol.ts';
import { DeviceBridge } from './device.ts';
import { UnreadStore } from './store.ts';
import type { UnreadState } from './store.ts';
import { observeRead } from './visibility.ts';

const labels: Record<UnreadState['status'], string> = {
  empty: '未同步', refreshing: '同步中', ready: '已同步', stale: '同步失败',
  suspended: '后台暂停', disconnected: '连接已断开', stopped: '模块已停用',
};

export const activate: ActivateFrontend = context => {
  if (context.apiVersion !== 2 || context.uiVersion !== 1 || context.menuVersion !== 1 || !context.state?.host ||
      typeof context.state.register !== 'function' || typeof context.onEvent !== 'function') {
    throw new Error('未读通知需要宿主 Module frontend v2 / UI v1 / menus v1、state 和 onEvent');
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
  const onMessage = (event: MessageEvent) => {
    const hint = device.handleMessage(event);
    if (hint) store.hint(hint);
  };
  const unsubscribeEvent = context.onEvent(store.onEvent);
  const unsubscribeView = context.state.host.subscribe(updateActivity);
  document.addEventListener('visibilitychange', updateActivity);
  window.addEventListener('online', updateActivity);
  window.addEventListener('offline', updateActivity);
  navigator.serviceWorker?.addEventListener('message', onMessage);
  updateActivity();
  void device.bootstrap();

  function useUnreadMessage(props: MessageProps) {
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
    const showMarker = known && message.kind !== 'ask';
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
      if (!showMarker || !element) { setHeight(null); return; }
      const measure = () => setHeight(element.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }, [id, showMarker, element]);
    React.useEffect(() => {
      if (!eligible || !element || !generation || !store.canPresent()) return;
      return observeRead(element,
        () => !stopped && store.canPresent() && context.state.host.getSnapshot().sessionId === message.sessionId &&
          store.getSnapshot().snapshot?.generation === generation,
        () => store.present(key, generation), 600);
    }, [id, eligible, element, generation, state.status]);
    const marker = showMarker ? <span className="cn-redline" role="img" aria-label="未读消息"
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

  const dispose = () => {
    if (stopped) return;
    stopped = true;
    unsubscribeView();
    unsubscribeEvent();
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
    menus: [{
      id: 'notification-toggle', menu: 'global',
      subscribe: device.subscribe,
      getState: () => {
        const status = device.getSnapshot();
        const enabled = status.registered || (!status.supported && status.subscribed);
        return {
          label: status.busy ? '通知处理中…' : enabled ? '关闭通知' :
            status.supported ? '开启通知' : '开启通知（当前环境不支持）',
          disabled: status.busy || (!enabled && !status.supported),
        };
      },
      onSelect: (_target, { signal }) => {
        signal.throwIfAborted();
        const status = device.getSnapshot();
        const enabled = status.registered || (!status.supported && status.subscribed);
        if (status.busy || (!enabled && !status.supported)) throw new Error('当前无法更改本设备通知');
        return enabled ? device.disable() : device.enable();
      },
    }],
    components: [
      { id: 'unread-marker', boundary: 'message', wrap: Base => function UnreadMessage(props) {
        const { bodyRef, marker } = useUnreadMessage(props);
        return <Base {...props} bodyRef={bodyRef} adornment={marker ? <>{props.adornment}{marker}</> : props.adornment} />;
      } },
      { id: 'unread-count', boundary: 'sessionStatus', wrap: Base => function UnreadSessionStatus(props) {
        return <Base {...props}>{props.children}<SessionBadge sessionId={props.sessionId} /></Base>;
      } },
    ],
    dispose,
  };
};
