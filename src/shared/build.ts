declare const __NOTIFICATION_BUILD__: string;
export const buildVersion = typeof __NOTIFICATION_BUILD__ === 'string' ? __NOTIFICATION_BUILD__ : 'dev+unknown';
