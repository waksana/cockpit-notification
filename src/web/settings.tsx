import type { ModuleFrontendContext } from '@waksana/cockpit-module-sdk/frontend';
import type { DeviceBridge, DeviceStatus } from './device.ts';

function cannotToggle(status: DeviceStatus) {
  return status.stopped || status.initializing || status.busy ||
    (!status.registered && (!status.supported || status.permission === 'denied' || status.permission === 'unsupported'));
}

function description(status: DeviceStatus) {
  if (status.stopped) return '通知模块已停用。';
  if (status.initializing) return '正在检查本设备的通知权限和登记状态…';
  if (status.busy) return '正在更新本设备通知…';
  if (!status.supported) return '当前环境不支持系统通知，请使用支持 Web Push 的安全连接或已安装的 PWA。';
  if (status.permission === 'denied') return '通知权限已被浏览器或系统阻止。请在浏览器或系统设置中允许后重新打开页面；已登记的通知仍可关闭。';
  if (status.needsResubscribe) return '订阅密钥已变更，请关闭后重新开启本设备通知。';
  if (status.permission === 'default') return status.registered
    ? '本设备已登记，但浏览器尚未允许通知。请关闭后重新开启以请求权限。'
    : '开启时将请求浏览器通知权限。';
  if (status.registered) return '本设备已登记通知；实际送达仍取决于浏览器、系统和网络。';
  if (status.subscribed) return '浏览器订阅仍在，但服务端尚未登记通知。可重新开启，或取消残留订阅。';
  return '仅管理本设备的系统通知，不影响未读标记和其他设备。';
}

export function createDeviceSettings(context: ModuleFrontendContext, device: DeviceBridge, isStopped: () => boolean) {
  const React = context.react;
  return function DeviceSettings() {
    const status = React.useSyncExternalStore(device.subscribe, device.getSnapshot, device.getSnapshot);
    const id = React.useId();
    React.useLayoutEffect(device.observeErrors, [device]);
    const inactive = () => isStopped() || context.signal.aborted;
    const pending = status.initializing || status.busy;
    const error = status.errorReported ? null : status.error;
    const toggle = () => {
      const current = device.getSnapshot();
      if (inactive() || cannotToggle(current)) return;
      void (current.registered ? device.disable() : device.enable());
    };
    const cleanup = () => {
      const current = device.getSnapshot();
      if (inactive() || current.stopped || current.initializing || current.busy ||
          current.registered || !current.subscribed) return;
      void device.disable();
    };
    return <section className="cn-device-settings" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="ck-heading">通知</h3>
      <div className="cn-device-setting">
        <span id={`${id}-label`}>本设备通知</span>
        <button type="button" className="ck-button cn-device-toggle" role="switch"
          aria-labelledby={`${id}-label`} aria-describedby={`${id}-status${error ? ` ${id}-error` : ''}`}
          aria-checked={status.registered} aria-busy={pending}
          disabled={inactive() || cannotToggle(status)} onClick={toggle}>
          <span aria-hidden="true">{status.initializing ? '检查中' : status.registered ? '已登记' : '未登记'}</span>
          <span className="cn-device-toggle-track" aria-hidden="true" />
        </button>
      </div>
      <p id={`${id}-status`} className="ck-status-text ck-text-secondary cn-device-description" role="status">
        {description(status)}
      </p>
      {status.updatePending && <p className="ck-status-text ck-text-secondary cn-device-description">
        通知组件更新尚未激活；如操作失败，请关闭旧窗口后重试。
      </p>}
      {error && <p id={`${id}-error`} className="ck-status-text ck-danger cn-device-description" role="alert">{error}</p>}
      {status.subscribed && !status.registered && <div className="ck-actions">
        <button type="button" className="ck-button" disabled={inactive() || status.stopped || pending} onClick={cleanup}>
          取消残留订阅
        </button>
      </div>}
    </section>;
  };
}
