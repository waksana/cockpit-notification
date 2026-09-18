import { parseDeviceState } from './device.ts';
import type { DeviceState } from './device.ts';

export class DeviceStorage {
  private factory: IDBFactory;
  private name: string;
  constructor(factory: IDBFactory, appBase: string) {
    this.factory = factory;
    this.name = `cockpit-notification-device-v1:${appBase}`;
  }
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      let settled = false;
      request.onupgradeneeded = () => { request.result.createObjectStore('version'); };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true;
        resolve(request.result);
      };
      request.onerror = () => { settled = true; reject(request.error ?? new Error('无法打开设备通知存储')); };
      request.onblocked = () => { settled = true; reject(new Error('设备通知存储升级被另一个页面阻塞')); };
    });
  }
  async load(): Promise<DeviceState | null> {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('version', 'readonly');
        const request = transaction.objectStore('version').get('current');
        transaction.oncomplete = () => {
          try { resolve(parseDeviceState(request.result)); } catch (error) { reject(error); }
        };
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('读取设备通知版本失败'));
      });
    } finally { database.close(); }
  }
  async save(state: DeviceState): Promise<void> {
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('version', 'readwrite');
        transaction.objectStore('version').put(state, 'current');
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('保存设备通知版本失败'));
      });
    } finally { database.close(); }
  }
}
